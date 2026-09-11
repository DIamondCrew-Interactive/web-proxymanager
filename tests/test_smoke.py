import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).resolve().parents[1] / 'scripts/smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SmokeSafetyTests(unittest.TestCase):
    def test_existing_directory_refused(self):
        with tempfile.TemporaryDirectory() as folder, self.assertRaisesRegex(RuntimeError, 'must not exist'):
            smoke.fresh_root(Path(folder))

    def test_repository_directory_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'separate'):
            smoke.fresh_root(smoke.ROOT / 'never-create-production-test-data')

    def test_production_and_duplicate_ports_refused(self):
        for ports in [(81, 18080, 18443), (18081, 18081, 18443), (28081, 28080, 28443)]:
            with self.assertRaises(RuntimeError):
                smoke.check_ports(ports)

    def test_compose_isolation(self):
        work = Path('/tmp/dci-npm-smoke-unit')
        config = smoke.compose_spec('dci-npm-smoke-unit', work, 'pinned-stock', 'pinned-runner', (18081, 18080, 18443))
        self.assertTrue(config['networks']['default']['internal'])
        self.assertFalse(config['networks']['publishing']['internal'])
        self.assertEqual(config['services']['app']['networks'], ['publishing', 'default'])
        self.assertNotIn('networks', config['services']['smoke-backend'])
        self.assertNotIn('ports', config['services']['smoke-backend'])
        self.assertEqual(config['services']['app']['ports'], [
            {'target': target, 'published': str(port), 'host_ip': '127.0.0.1', 'protocol': 'tcp'}
            for target, port in ((81, 18081), (80, 18080), (443, 18443))])
        self.assertEqual([m['source'] for m in config['services']['app']['volumes']], [str(work / 'data'), str(work / 'letsencrypt')])
        self.assertTrue(all(not m['bind']['create_host_path'] for service in config['services'].values() for m in service.get('volumes', [])))
        self.assertEqual(config['services']['ui']['network_mode'], 'service:app')
        self.assertFalse(any('container_name' in s for s in config['services'].values()))

    def app_inspect(self):
        return {'Id': 'a' * 64, 'Name': '/dci-test-app', 'Image': 'stock',
                'Config': {'Labels': {'com.docker.compose.project': 'dci-test', 'com.docker.compose.service': 'app'}},
                'State': {'StartedAt': 'unchanged', 'Status': 'running', 'Health': {'Status': 'healthy'}},
                'HostConfig': {'PortBindings': {f'{target}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]
                                              for target, port in ((81, 18081), (80, 18080), (443, 18443))}},
                'Mounts': [{'Type': 'bind', 'Source': str(Path('/tmp/test') / source), 'Destination': target}
                           for source, target in [('data', '/data'), ('letsencrypt', '/etc/letsencrypt')]],
                'NetworkSettings': {'Networks': {'test': {}}, 'Ports': {f'{target}/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]
                                                                      for target, port in ((81, 18081), (80, 18080), (443, 18443))}}}

    def test_actual_port_bindings_required_before_health(self):
        item = self.app_inspect()
        smoke.assert_test_app(item, 'dci-test', Path('/tmp/test'), (18081, 18080, 18443))
        for section, key in [('NetworkSettings', 'Ports'), ('HostConfig', 'PortBindings')]:
            for mapping in [{}, {'81/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '18081'}]}]:
                bad = copy.deepcopy(item)
                bad[section][key] = mapping
                with self.assertRaisesRegex(RuntimeError, 'loopback port publishing'):
                    smoke.assert_test_app(bad, 'dci-test', Path('/tmp/test'), (18081, 18080, 18443))

    def test_app_ownership_and_mounts_enforced(self):
        for change in ('project', 'name', 'mount'):
            item = self.app_inspect()
            if change == 'project':
                item['Config']['Labels']['com.docker.compose.project'] = 'production'
            elif change == 'name':
                item['Name'] = '/nginx-proxy-manager_app_1'
            else:
                item['Mounts'][0]['Source'] = '/opt/nginx-proxy-manager/data'
            with self.assertRaises(RuntimeError):
                smoke.assert_test_app(item, 'dci-test', Path('/tmp/test'), (18081, 18080, 18443))

    def test_existing_comparison_ignores_health_mount_order_and_new_containers(self):
        item = self.app_inspect()
        initial = {item['Id']: smoke.container_fingerprint(item)}
        item['State']['Health']['Status'] = 'starting'
        item['Mounts'].reverse()
        with patch.object(smoke, 'run', return_value=json.dumps([item])) as run:
            self.assertEqual(smoke.compare_existing(initial), ('PASS', {'changed_fields': {}, 'inspection_errors': {}}))
            run.assert_called_once_with('docker', 'inspect', item['Id'])

    def test_existing_restart_config_and_removal_do_not_pass(self):
        item = self.app_inspect()
        initial = {item['Id']: smoke.container_fingerprint(item)}
        for key in ('restart', 'config'):
            changed = copy.deepcopy(item)
            if key == 'restart':
                changed['State']['StartedAt'] = 'restarted'
            else:
                changed['HostConfig']['PortBindings'] = {}
            with patch.object(smoke, 'run', return_value=json.dumps([changed])):
                status, details = smoke.compare_existing(initial)
                self.assertEqual(status, 'FAIL')
                self.assertTrue(details['changed_fields'][item['Id']])
        with patch.object(smoke, 'run', side_effect=subprocess.CalledProcessError(1, 'inspect')):
            status, details = smoke.compare_existing(initial)
            self.assertEqual(status, 'NOT_VERIFIED')
            self.assertIn(item['Id'], details['inspection_errors'])

    def test_failure_diagnostics_continue_after_compose_ps_error(self):
        item = self.app_inspect()
        calls = []
        def execute(args, **kwargs):
            calls.append(args)
            if args[1] == 'compose':
                return subprocess.CompletedProcess(args, 1, b'', b'compose failed')
            if args[1] == 'ps':
                return subprocess.CompletedProcess(args, 0, (item['Id'] + '\n').encode(), b'')
            if args[1] == 'inspect':
                return subprocess.CompletedProcess(args, 0, json.dumps([item]).encode(), b'')
            return subprocess.CompletedProcess(args, 0, b'test log', b'test stderr')
        with tempfile.TemporaryDirectory() as directory, patch.object(smoke.subprocess, 'run', side_effect=execute):
            smoke.collect_diagnostics(['docker', 'compose', '-p', 'dci-test'], 'dci-test', Path(directory))
            folder = Path(directory) / 'diagnostics'
            self.assertEqual(json.loads((folder / (item['Id'] + '.ports.json')).read_text()), item['NetworkSettings']['Ports'])
            self.assertEqual((folder / (item['Id'] + '.logs.txt')).read_text(), 'test log')
            self.assertIn('label=com.docker.compose.project=dci-test', calls[1])

    def test_yaml_is_block_style_and_quotes_scalars(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'compose.yaml'
            smoke.write_yaml(target, {'services': {'app': {'restart': 'no', 'ports': [{'published': '18081'}]}}})
            self.assertEqual(target.read_text(), '"services":\n  "app":\n    "restart": "no"\n    "ports":\n      -\n        "published": "18081"\n')

    def test_image_ancestry_and_config_enforced(self):
        stock = {'Id': smoke.LOCK['snapshotImageId'], 'RootFS': {'Layers': ['base1', 'base2']}, 'Config': {'Env': ['SAFE=1']}}
        custom = {'Id': 'custom', 'Architecture': 'amd64', 'Os': 'linux', 'RootFS': {'Layers': ['base1', 'base2', 'theme']}, 'Config': {'Env': ['SAFE=1'], 'Labels': {'net.diamondcrew.upstream.version': smoke.LOCK['version']}}}
        self.assertEqual(smoke.image_invariants(stock, custom), 2)
        for change in ('layers', 'environment'):
            bad = copy.deepcopy(custom)
            if change == 'layers':
                bad['RootFS']['Layers'][0] = 'wrong-base'
            else:
                bad['Config']['Env'] = ['CHANGED=1']
            with self.assertRaises(RuntimeError):
                smoke.image_invariants(stock, bad)

    def archive(self, folder, path, link=False):
        blob = io.BytesIO()
        with tarfile.open(fileobj=blob, mode='w') as inner:
            file = tarfile.TarInfo(path)
            if link:
                file.type = tarfile.SYMTYPE
                file.linkname = '/etc/passwd'
                inner.addfile(file)
            else:
                file.size = 4
                inner.addfile(file, io.BytesIO(b'test'))
        config = b'{"test":"synthetic image"}'
        manifest = [{'Config': 'config.json', 'Layers': ['base.tar', 'theme.tar']}]
        archive = folder / 'image.tar'
        with tarfile.open(archive, 'w') as outer:
            for name, data in [('manifest.json', json.dumps(manifest).encode()), ('config.json', config), ('theme.tar', blob.getvalue())]:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                outer.addfile(member, io.BytesIO(data))
        return archive, 'sha256:' + hashlib.sha256(config).hexdigest()

    def test_expected_frontend_layer_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            archive, image = self.archive(folder, 'app/frontend/index.html')
            self.assertEqual(smoke.scan_added_layers(archive, 1, image, folder / 'scan'), 1)

    def test_data_secrets_traversal_and_symlinks_rejected(self):
        for name, link in [('data/database.sqlite', False), ('etc/letsencrypt/account.json', False),
                           ('app/frontend/.env', False), ('app/frontend/test.key', False),
                           ('app/frontend/../outside', False), ('app/frontend/link', True),
                           ('app/frontend/.wh.index.html', False)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                archive, image = self.archive(folder, name, link)
                with self.assertRaises(RuntimeError):
                    smoke.scan_added_layers(archive, 1, image, folder / 'scan')

    @unittest.skipUnless(shutil.which('node'), 'Node needed for local probe self-test')
    def test_local_http_and_websocket_probe_harness(self):
        # This is a harness test, explicitly NOT an NPM/Docker integration result.
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        environment = dict(os.environ, DCI_SMOKE_PORTS=str(port), DCI_SMOKE_BIND='127.0.0.1')
        backend = subprocess.Popen(['node', str(smoke.ROOT / 'tests/integration/backend.mjs')], env=environment,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            smoke.ready_probe(lambda: smoke.proxy_http(port, port))
            smoke.websocket_echo(port)
        finally:
            backend.terminate()
            backend.wait(timeout=10)


OPENSSL = shutil.which('openssl')
if not OPENSSL and Path('C:/Program Files/Git/usr/bin/openssl.exe').is_file():
    OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'


@unittest.skipUnless(OPENSSL, 'OpenSSL needed for real local TLS regression tests')
class SmokeTLSTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.folder = Path(cls.temp.name)
        (cls.folder / 'openssl.cnf').write_text('[req]\ndistinguished_name=dn\n[dn]\n')
        for name, hostname in [('trusted', smoke.TLS_HOSTNAME), ('wrong-host', 'wrong.smoke.dci.test'),
                               ('untrusted', smoke.TLS_HOSTNAME)]:
            subprocess.run([OPENSSL, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                            '-config', str(cls.folder / 'openssl.cnf'), '-subj', '/CN=' + hostname,
                            '-addext', 'subjectAltName=DNS:' + hostname,
                            '-keyout', str(cls.folder / (name + '.key')),
                            '-out', str(cls.folder / (name + '.pem'))],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def probe(self, served, trusted, expected_error=None):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(self.folder / (served + '.pem')), str(self.folder / (served + '.key')))
        seen, requests, errors = [], [], []
        def sni(sock, hostname, ctx):
            seen.append(hostname)
            if hostname != smoke.TLS_HOSTNAME:
                return ssl.ALERT_DESCRIPTION_UNRECOGNIZED_NAME
        context.set_servername_callback(sni)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            listener.settimeout(5)
            port = listener.getsockname()[1]
            def serve():
                try:
                    raw, peer = listener.accept()
                    with raw:
                        raw.settimeout(5)
                        with context.wrap_socket(raw, server_side=True) as connection:
                            request = b''
                            while b'\r\n\r\n' not in request:
                                part = connection.recv(4096)
                                if not part:
                                    raise RuntimeError('Missing HTTP request')
                                request += part
                            requests.append(request)
                            body = json.dumps({'service': 'dci-smoke-backend', 'port': 8080}).encode()
                            connection.sendall(b'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ' +
                                               str(len(body)).encode() + b'\r\n\r\n' + body)
                except Exception as error:
                    errors.append(error)
            worker = threading.Thread(target=serve, daemon=True)
            worker.start()
            try:
                if expected_error:
                    with self.assertRaises(ssl.SSLCertVerificationError) as caught:
                        smoke.proxy_http(port, 8080, tls=True, certificate=self.folder / (trusted + '.pem'))
                    self.assertIn(expected_error, caught.exception.verify_message.lower())
                else:
                    smoke.proxy_http(port, 8080, tls=True, certificate=self.folder / (trusted + '.pem'))
            finally:
                worker.join(timeout=6)
            self.assertFalse(worker.is_alive())
        self.assertEqual(seen, [smoke.TLS_HOSTNAME])
        if expected_error:
            self.assertEqual(requests, [])
        else:
            self.assertEqual(errors, [])
            self.assertTrue(requests[0].startswith(b'GET /smoke HTTP/1.1\r\n'))
            self.assertIn(b'\r\nHost: tls.smoke.dci.test\r\n', requests[0])

    def test_real_loopback_tls_requires_sni_and_serves_expected_http(self):
        self.probe('trusted', 'trusted')

    def test_trusted_certificate_with_wrong_hostname_rejected(self):
        self.probe('wrong-host', 'wrong-host', 'hostname mismatch')

    def test_correct_hostname_with_untrusted_certificate_rejected(self):
        self.probe('untrusted', 'trusted', 'self-signed certificate')

    def test_fixed_loopback_destination_and_explicit_sni(self):
        connection = smoke.SmokeHTTPSConnection(18443, self.folder / 'trusted.pem')
        self.assertTrue(connection._context.check_hostname)
        self.assertEqual(connection._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(connection._context.cert_store_stats()['x509'], 1)
        context = MagicMock()
        connection._context = context
        with patch.object(smoke.socket, 'create_connection') as create:
            connection.connect()
            create.assert_called_once_with(('127.0.0.1', 18443), timeout=10)
            context.wrap_socket.assert_called_once_with(create.return_value, server_hostname='tls.smoke.dci.test')
        connection.close()


if __name__ == '__main__':
    unittest.main()
