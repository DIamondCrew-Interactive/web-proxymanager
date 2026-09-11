#!/usr/bin/env python3
"""Manual, isolated Linux Docker smoke test. Never targets a production project."""
import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tarfile
import time
import traceback
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'upstream.lock.json').read_text())
PRODUCTION = Path('/opt/nginx-proxy-manager')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, log=None):
    # No shell, no command interpolation, no credentials in command arguments.
    if log:
        with Path(log).open('ab') as stream:
            subprocess.run([str(a) for a in args], stdout=stream, stderr=subprocess.STDOUT, check=True)
        return ''
    return subprocess.check_output([str(a) for a in args], text=True, stderr=subprocess.PIPE).strip()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fresh_root(path):
    path = path.resolve()
    require(not path.exists(), 'Work directory must not exist; each run starts with fresh data')
    for forbidden in (ROOT, PRODUCTION):
        require(path != forbidden and forbidden not in path.parents and path not in forbidden.parents,
                'Work directory must be separate from the repository and production data')
    require(len(path.parts) >= 3, 'Choose a dedicated test directory, not a filesystem root')
    return path


def check_ports(ports):
    require(len(set(ports)) == len(ports), 'All test ports must be distinct')
    for port in ports:
        require(1024 < port < 65536, 'Use unprivileged test ports above 1024')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', port))


def compose_spec(project, work, stock, runner, ports):
    admin, http, https = ports
    def mount(source, target, readonly=False):
        return {'type': 'bind', 'source': str(source), 'target': target, 'read_only': readonly,
                'bind': {'create_host_path': False}}
    return {'name': project, 'services': {
        'app': {'image': stock, 'pull_policy': 'never', 'restart': 'no', 'cpus': 1.0, 'mem_limit': '1g',
                'pids_limit': 512, 'environment': {'IP_RANGES_FETCH_ENABLED': 'false'},
                'ports': [f'127.0.0.1:{admin}:81', f'127.0.0.1:{http}:80', f'127.0.0.1:{https}:443'],
                'volumes': [mount(work / 'data', '/data'), mount(work / 'letsencrypt', '/etc/letsencrypt')]},
        'smoke-backend': {'image': LOCK['builder'], 'pull_policy': 'never', 'restart': 'no',
                          'entrypoint': ['node', '/test/backend.mjs'], 'cpus': 0.5, 'mem_limit': '128m',
                          'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
                          'volumes': [mount(work / 'backend.mjs', '/test/backend.mjs', True)]},
        'ui': {'image': runner, 'pull_policy': 'never', 'profiles': ['test'], 'restart': 'no',
               'network_mode': 'service:app', 'cpus': 1.0, 'mem_limit': '2g', 'shm_size': '512m',
               'volumes': [mount(work / 'private/credentials.json', '/run/smoke/credentials.json', True)]}
    }, 'networks': {'default': {'internal': True}}}


def image_invariants(stock, custom):
    require(stock['Id'] == LOCK['snapshotImageId'], 'Stock image ID does not match the DIA-01 snapshot')
    require(custom['Architecture'] == 'amd64' and custom['Os'] == 'linux', 'Expected Linux AMD64 image')
    base = stock['RootFS']['Layers']
    layers = custom['RootFS']['Layers']
    require(layers[:len(base)] == base and len(layers) > len(base), 'Custom image is not layered on the exact stock image')
    for name in ('Entrypoint', 'Cmd', 'Env', 'Volumes', 'ExposedPorts', 'User', 'WorkingDir', 'Healthcheck'):
        require(custom['Config'].get(name) == stock['Config'].get(name), f'Unexpected runtime config change: {name}')
    require(custom['Config'].get('Labels', {}).get('net.diamondcrew.upstream.version') == LOCK['version'], 'Wrong upstream label')
    return len(base)


def scan_added_layers(archive, base_count, custom_id, destination):
    """Inspect image save layers, not container export (which excludes volume contents)."""
    allowed_file = 'usr/share/licenses/diamondcrew-proxy-manager/LICENSE.upstream'
    parents = {'app', 'app/frontend', 'usr', 'usr/share', 'usr/share/licenses',
               'usr/share/licenses/diamondcrew-proxy-manager'}
    checked = 0
    with tarfile.open(archive) as outer:
        manifest = json.load(outer.extractfile('manifest.json'))
        entries = [entry for entry in manifest if hashlib.sha256(outer.extractfile(entry['Config']).read()).hexdigest() == custom_id.removeprefix('sha256:')]
        require(len(entries) == 1, 'Cannot identify exact custom config in image save archive')
        entry = entries[0]
        require(len(entry['Layers']) > base_count, 'No added layers to inspect')
        for layer_name in entry['Layers'][base_count:]:
            with tarfile.open(fileobj=outer.extractfile(layer_name), mode='r|*') as layer:
                for member in layer:
                    path = PurePosixPath(member.name)
                    require(not path.is_absolute() and '..' not in path.parts, 'Unsafe path in image layer')
                    name = str(path)
                    if name == '.':
                        continue
                    allowed = name.startswith('app/frontend/') or name == allowed_file or (member.isdir() and name in parents)
                    require(allowed, f'Unexpected added layer path: {name}')
                    require(not member.issym() and not member.islnk() and (member.isdir() or member.isfile()), 'Unexpected image layer link/device')
                    require(not path.name.startswith(('.env', '.wh.')) and path.suffix.lower() not in {'.db', '.sqlite', '.sqlite3', '.pem', '.key', '.p12', '.pfx'}, 'Forbidden data in custom image layer')
                    if member.isfile():
                        target = destination / path
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with target.open('wb') as output:
                            shutil.copyfileobj(layer.extractfile(member), output)
                        checked += 1
    require(checked > 0 and (destination / 'app/frontend/index.html').exists(), 'Missing rebuilt frontend')
    return checked


class API:
    def __init__(self, port):
        self.base = f'http://127.0.0.1:{port}/api'
        self.token = None
        # Never send the local smoke requests via a host HTTP proxy.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method, path, body=None, content_type='application/json'):
        headers = {'Content-Type': content_type}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        data = json.dumps(body).encode() if body is not None and not isinstance(body, bytes) else body
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # Do not echo API payloads, which can include synthetic passwords or keys.
            raise RuntimeError(f'API {method} {path} returned HTTP {error.code}') from None

    def healthy(self):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                data = self.request('GET', '/')
                if data.get('status') == 'OK':
                    require(data['version'] == {'major': 2, 'minor': 15, 'revision': 1}, 'Unexpected backend version')
                    return data
            except (urllib.error.URLError, TimeoutError, OSError, RuntimeError):
                pass
            time.sleep(2)
        raise RuntimeError('NPM backend did not become healthy within 180 seconds')

    def login(self, credentials):
        result = self.request('POST', '/tokens', {'identity': credentials['email'], 'secret': credentials['password']})
        require(bool(result.get('token')), 'Login did not return a session')
        self.token = result['token']


def multipart(files):
    boundary = 'dci-' + secrets.token_hex(16)
    parts = []
    for field, path in files.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + path.read_bytes() + b'\r\n')
    return b''.join(parts) + f'--{boundary}--\r\n'.encode(), f'multipart/form-data; boundary={boundary}'


def proxy_http(port, expected_port, tls=False):
    context = ssl._create_unverified_context() if tls else None
    connection = http.client.HTTPSConnection('127.0.0.1', port, timeout=10, context=context) if tls else http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    try:
        connection.request('GET', '/smoke', headers={'Host': 'tls.smoke.dci.test' if tls else 'smoke.dci.test'})
        response = connection.getresponse()
        require(response.status == 200, 'Proxy HTTP response is not 200')
        require(json.loads(response.read()) == {'service': 'dci-smoke-backend', 'port': expected_port}, 'Wrong proxy destination/body')
    finally:
        connection.close()


def ready_probe(probe):
    deadline = time.monotonic() + 45
    while True:
        try:
            return probe()
        except (RuntimeError, OSError, http.client.HTTPException):
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)


def proxy_checks(http_port, https_port):
    ready_probe(lambda: proxy_http(http_port, 8081))
    ready_probe(lambda: proxy_http(https_port, 8080, tls=True))
    ready_probe(lambda: websocket_echo(http_port))


def websocket_echo(port):
    key = base64.b64encode(secrets.token_bytes(16)).decode()
    payload = ('dci-echo-' + secrets.token_hex(8)).encode()
    with socket.create_connection(('127.0.0.1', port), timeout=10) as connection:
        connection.sendall((f'GET /ws HTTP/1.1\r\nHost: smoke.dci.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n').encode())
        stream = connection.makefile('rb')
        require(b' 101 ' in stream.readline(4096), 'WebSocket upgrade did not return 101')
        headers = {}
        while True:
            line = stream.readline(4096)
            require(bool(line), 'Incomplete WebSocket handshake')
            if line == b'\r\n':
                break
            name, value = line.decode().split(':', 1)
            headers[name.lower()] = value.strip()
        expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        require(headers.get('sec-websocket-accept') == expected, 'Invalid WebSocket handshake accept')
        mask = secrets.token_bytes(4)
        connection.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(payload)))
        head = stream.read(2)
        require(head == bytes([0x81, len(payload)]), 'Unexpected WebSocket echo frame')
        require(stream.read(len(payload)) == payload, 'WebSocket proxy payload was not echoed')


def inventory():
    ids = run('docker', 'ps', '-aq').splitlines()
    if not ids:
        return {}
    items = json.loads(run('docker', 'inspect', *ids))
    # Only hashes and lifecycle fields are retained, never environment values.
    return {item['Id']: {'started': item['State']['StartedAt'], 'status': item['State']['Status'],
                        'configuration': hashlib.sha256(json.dumps({k: item[k] for k in ('Config', 'HostConfig', 'Mounts')}, sort_keys=True).encode()).hexdigest()} for item in items}


def data_state(api):
    return {
        'hosts': sorted([(h['id'], h['domain_names'], h['forward_host'], h['forward_port'], h['allow_websocket_upgrade'], h['certificate_id']) for h in api.request('GET', '/nginx/proxy-hosts')]),
        'users': sorted([(u['id'], u['email'], u['roles']) for u in api.request('GET', '/users')]),
        'access': sorted([(a['id'], a['name']) for a in api.request('GET', '/nginx/access-lists')]),
        'certificates': sorted([(c['id'], c['nice_name'], c['domain_names']) for c in api.request('GET', '/nginx/certificates')]),
        'setting': api.request('GET', '/settings/default-site')['value']
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workdir', type=Path, required=True)
    parser.add_argument('--gitleaks', required=True, help='Path to preinstalled Gitleaks 8.24.2')
    parser.add_argument('--admin-port', type=int, default=18081)
    parser.add_argument('--http-port', type=int, default=18080)
    parser.add_argument('--https-port', type=int, default=18443)
    parser.add_argument('--keep-running', action='store_true', help='Leave the test stack running after rollback; default stops only this test stack')
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0, 'Run with sudo on the Linux Docker host (Python 3.11+)')
    require(not os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'), 'Unset Docker endpoint overrides; only a local daemon is supported')
    context = json.loads(run('docker', 'context', 'inspect'))[0]
    require(context['Endpoints']['docker']['Host'].startswith('unix://'), 'Remote Docker context is forbidden')
    require(run('docker', 'info', '--format', '{{.OSType}}/{{.Architecture}}') in ('linux/x86_64', 'linux/amd64'), 'Native Linux AMD64 Docker required')
    run('docker', 'compose', 'version'); run('docker', 'buildx', 'version'); run('openssl', 'version')
    scanner = Path(shutil.which(args.gitleaks) or args.gitleaks).resolve(strict=True)
    require('8.24.2' in run(scanner, 'version'), 'Use the reviewed Gitleaks 8.24.2 binary')
    work = fresh_root(args.workdir)
    ports = (args.admin_port, args.http_port, args.https_port)
    check_ports(ports)
    ancestor = work.parent
    while not ancestor.exists():
        ancestor = ancestor.parent
    require(shutil.disk_usage(ancestor).free >= 8 * 1024**3, 'At least 8 GiB free test/archive space is required (plus Docker storage space)')
    os.umask(0o077)
    work.mkdir(parents=True, mode=0o700)
    for name in ('data', 'letsencrypt', 'private', 'layer-scan', 'release'):
        (work / name).mkdir(mode=0o700)
    unique = secrets.token_hex(6)
    project = 'dci-npm-smoke-' + unique
    builder = project + '-builder'
    tag = 'diamondcrew-interactive/proxy-manager:2.15.1-dci.1.0.0-smoke-' + unique
    runner = 'diamondcrew-interactive/npm-smoke-ui:' + unique
    credentials = {'email': 'admin@smoke.example.test', 'password': secrets.token_urlsafe(36)}
    write_json(work / 'private/credentials.json', credentials)
    shutil.copyfile(ROOT / 'tests/integration/backend.mjs', work / 'backend.mjs')
    for directory in ('data', 'letsencrypt'):
        (work / directory / 'dci-smoke-sentinel').write_bytes(secrets.token_bytes(32))
    sentinels = {directory: sha(work / directory / 'dci-smoke-sentinel') for directory in ('data', 'letsencrypt')}
    config = work / 'compose.json'
    write_json(config, compose_spec(project, work, LOCK['image'], runner, ports))
    command = ['docker', 'compose', '-p', project, '-f', str(config)]
    initial = inventory()
    require(not run('docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project), 'Project collision')
    results = {'source_scan': 'NOT_RUN', 'docker_build': 'NOT_RUN', 'image_invariants': 'NOT_RUN', 'secret_scan': 'NOT_RUN',
               'integration': 'NOT_RUN', 'persistence': 'NOT_RUN', 'rollback': 'NOT_RUN',
               'existing_containers_unchanged': 'NOT_RUN', 'tag': tag, 'stock': LOCK['image'],
               'registry_digest': None, 'acme_issuance': 'NOT_RUN (offline test)', 'project': project}
    builder_created = False
    stack_started = False
    stage = 'source_scan'
    try:
        print('Scanning source and building isolated images...', flush=True)
        run(sys.executable, ROOT / 'scripts/secret-scan.py', '--gitleaks', scanner, '--package', log=work / 'source-scan.log')
        shutil.copyfile(ROOT / '.build/diamondcrew-proxy-manager-source.zip', work / 'release/source.zip')
        results['source_scan'] = 'PASS'
        stage = 'docker_build'
        run('docker', 'pull', '--platform', 'linux/amd64', LOCK['image'], log=work / 'pull.log')
        run('docker', 'pull', '--platform', 'linux/amd64', LOCK['builder'], log=work / 'pull.log')
        run('docker', 'buildx', 'create', '--name', builder, '--driver', 'docker-container',
            '--driver-opt', 'memory=4g,cpu-period=100000,cpu-quota=200000')
        builder_created = True
        common = ['docker', 'buildx', 'build', '--builder', builder, '--platform', 'linux/amd64', '--load']
        run(*common, '--metadata-file', work / 'build-metadata.json', '-t', tag, ROOT, log=work / 'build.log')
        run(*common, '-t', runner, ROOT / 'tests/integration', log=work / 'ui-build.log')
        results['docker_build'] = 'PASS'
        stage = 'image_invariants'
        stock = json.loads(run('docker', 'image', 'inspect', LOCK['image']))[0]
        custom = json.loads(run('docker', 'image', 'inspect', tag))[0]
        base_count = image_invariants(stock, custom)
        results['image_id'] = custom['Id']
        results['build_manifest_digest'] = json.loads((work / 'build-metadata.json').read_text()).get('containerimage.digest')
        run('docker', 'image', 'save', '-o', work / 'release/image.tar', tag)
        results['added_files_checked'] = scan_added_layers(work / 'release/image.tar', base_count, custom['Id'], work / 'layer-scan')
        results['image_invariants'] = 'PASS'
        stage = 'secret_scan'
        run(scanner, 'dir', work / 'layer-scan', '--redact', '--no-banner', '--report-format', 'json', '--report-path', work / 'layer-secret-scan.json', log=work / 'layer-scan.log')
        results['secret_scan'] = 'PASS'
        print('Starting a fresh stock test stack and preparing rollback backup...', flush=True)
        stage = 'integration'
        # Mark before up: even a partially successful startup is cleaned up in finally.
        stack_started = True
        run(*command, 'up', '-d', '--pull', 'never', 'app', 'smoke-backend', log=work / 'compose.log')
        api = API(args.admin_port)
        require(api.healthy().get('setup') is False, 'Test data is not empty: setup was already completed')
        api.request('POST', '/users', {'name': 'Smoke Administrator', 'nickname': 'Smoke', 'email': credentials['email'], 'auth': {'type': 'password', 'secret': credentials['password']}})
        api.login(credentials)
        require(api.request('GET', '/nginx/proxy-hosts') == [], 'Fresh test stack unexpectedly contains proxy hosts')
        run(sys.executable, ROOT / 'scripts/ops.py', 'backup', '--compose', config, '--backup', work / 'backup', log=work / 'ops-backup.log')
        run(sys.executable, ROOT / 'scripts/ops.py', 'deploy', '--backup', work / 'backup', '--image', tag, log=work / 'ops-deploy.log')
        api.healthy(); api.login(credentials)
        cid = run(*command, 'ps', '-q', 'app')
        actual = json.loads(run('docker', 'inspect', cid))[0]
        require(actual['Image'] == custom['Id'], 'Custom image was not activated')
        require({m['Destination']: m['Source'] for m in actual['Mounts']} == {'/data': str(work / 'data'), '/etc/letsencrypt': str(work / 'letsencrypt')}, 'Test container mounts differ from isolated paths')
        api.request('POST', '/nginx/access-lists', {'name': 'Smoke Access List', 'satisfy_any': False, 'pass_auth': False, 'items': [], 'clients': []})
        api.request('POST', '/users', {'name': 'Smoke Viewer', 'nickname': 'Viewer', 'email': 'viewer@smoke.example.test', 'roles': [], 'auth': {'type': 'password', 'secret': secrets.token_urlsafe(36)}})
        require(isinstance(api.request('GET', '/nginx/certificates/dns-providers'), list), 'DNS provider API failed')
        certificate = work / 'private/test-certificate.pem'
        key = work / 'private/test-key.pem'
        run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=tls.smoke.dci.test', '-addext', 'subjectAltName=DNS:tls.smoke.dci.test', '-keyout', key, '-out', certificate, log=work / 'openssl.log')
        body, content_type = multipart({'certificate': certificate, 'certificate_key': key})
        api.request('POST', '/nginx/certificates/validate', body, content_type)
        cert = api.request('POST', '/nginx/certificates', {'provider': 'other', 'nice_name': 'Smoke local certificate'})
        api.request('POST', f"/nginx/certificates/{cert['id']}/upload", body, content_type)
        print('Running Chromium against the real custom container API (no API mocks)...', flush=True)
        run(*command, '--profile', 'test', 'run', '--rm', '--no-deps', 'ui', log=work / 'live-ui.log')
        hosts = api.request('GET', '/nginx/proxy-hosts')
        primary = next(h for h in hosts if h['domain_names'] == ['smoke.dci.test'])
        require(primary['forward_port'] == 8081 and primary['allow_websocket_upgrade'], 'UI edits were not saved')
        api.request('POST', '/nginx/proxy-hosts', {'domain_names': ['tls.smoke.dci.test'], 'forward_scheme': 'http', 'forward_host': 'smoke-backend', 'forward_port': 8080, 'certificate_id': cert['id'], 'ssl_forced': True, 'allow_websocket_upgrade': True})
        run('docker', 'exec', cid, 'nginx', '-t', log=work / 'nginx-check.log')
        generated = run('docker', 'exec', cid, 'cat', f"/data/nginx/proxy_host/{primary['id']}.conf")
        require('proxy_set_header Upgrade' in generated and '8081' in generated, 'Generated Nginx WebSocket config missing')
        proxy_checks(args.http_port, args.https_port)
        logs = api.request('GET', '/audit-log')
        require(any(e['object_type'] == 'proxy-host' and e['object_id'] == primary['id'] and e['action'] == 'created' for e in logs), 'Audit create event missing')
        require(any(e['object_type'] == 'proxy-host' and e['object_id'] == primary['id'] and e['action'] == 'updated' for e in logs), 'Audit update event missing')
        before = data_state(api)
        results['integration'] = 'PASS'
        stage = 'persistence'
        print('Restarting only the test NPM and verifying persistence...', flush=True)
        run(*command, 'restart', 'app', log=work / 'restart.log')
        api.healthy(); api.login(credentials)
        require(data_state(api) == before, 'Test API data changed after restart')
        require(all(sha(work / d / 'dci-smoke-sentinel') == digest for d, digest in sentinels.items()), 'Persistent mount sentinel changed')
        proxy_checks(args.http_port, args.https_port)
        results['persistence'] = 'PASS'
        stage = 'rollback'
        print('Running the actual ops.py stock rollback against the test project...', flush=True)
        run(sys.executable, ROOT / 'scripts/ops.py', 'rollback', '--backup', work / 'backup', log=work / 'ops-rollback.log')
        api.healthy(); api.login(credentials)
        cid = run(*command, 'ps', '-q', 'app')
        require(json.loads(run('docker', 'inspect', cid))[0]['Image'] == stock['Id'], 'Rollback did not restore stock image ID')
        require(data_state(api) == before, 'Rollback lost changes made after the backup')
        with api.opener.open(f'http://127.0.0.1:{args.admin_port}/', timeout=10) as response:
            require('<title>Nginx Proxy Manager</title>' in response.read().decode(), 'Rollback frontend is not stock')
        require(all(sha(work / d / 'dci-smoke-sentinel') == digest for d, digest in sentinels.items()), 'Rollback changed mount sentinel')
        proxy_checks(args.http_port, args.https_port)
        results['rollback'] = 'PASS'
    except Exception as error:
        results[stage] = 'FAIL'
        (work / 'failure.txt').write_text(traceback.format_exc())
        # Detailed process logs stay private. The release report contains no payloads.
        results['failure_type'] = type(error).__name__
        print(f'Smoke test stopped in {stage}: {type(error).__name__}. Inspect private logs in {work}.', file=sys.stderr)
    finally:
        if stack_started and not args.keep_running:
            try:
                run(*command, '--profile', 'test', 'down', '--remove-orphans', log=work / 'cleanup.log')
            except subprocess.CalledProcessError:
                results['cleanup'] = 'FAIL'
        if builder_created:
            try:
                run('docker', 'buildx', 'rm', builder, log=work / 'cleanup.log')
            except subprocess.CalledProcessError:
                results['builder_cleanup'] = 'FAIL'
        try:
            after = inventory()
            results['existing_containers_unchanged'] = 'PASS' if all(after.get(cid) == state for cid, state in initial.items()) else 'FAIL'
        except subprocess.CalledProcessError:
            results['existing_containers_unchanged'] = 'FAIL'
        gates = ('source_scan', 'docker_build', 'image_invariants', 'secret_scan', 'integration', 'persistence', 'rollback', 'existing_containers_unchanged')
        passed = all(results[g] == 'PASS' for g in gates) and not any(results.get(k) == 'FAIL' for k in ('cleanup', 'builder_cleanup'))
        results['release_candidate_verified'] = passed
        write_json(work / 'report.json', results)
        if passed:
            shutil.copyfile(work / 'report.json', work / 'release/report.json')
            shutil.copyfile(ROOT / 'upstream.lock.json', work / 'release/upstream.lock.json')
            for file in (work / 'release').iterdir():
                if file.is_file() and file.suffix != '.sha256':
                    file.with_name(file.name + '.sha256').write_text(sha(file) + '  ' + file.name + '\n')
            (work / 'release/VERIFIED').write_text(custom['Id'] + '\n')
        else:
            (work / 'release/NOT_VERIFIED').write_text('Do not release: inspect report.json in the test work directory.\n')
        print(json.dumps(results, indent=2))
        print(f'Private test data/logs: {work}. Publish ONLY release/ after VERIFIED exists.')
    return 0 if results['release_candidate_verified'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(f'Preflight stopped: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
