import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tarfile
import tempfile
import unittest

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
        for ports in [(81, 18080, 18443), (18081, 18081, 18443)]:
            with self.assertRaises(RuntimeError):
                smoke.check_ports(ports)

    def test_compose_isolation(self):
        work = Path('/tmp/dci-npm-smoke-unit')
        config = smoke.compose_spec('dci-npm-smoke-unit', work, 'pinned-stock', 'pinned-runner', (18081, 18080, 18443))
        self.assertTrue(config['networks']['default']['internal'])
        self.assertTrue(all(p.startswith('127.0.0.1:18') for p in config['services']['app']['ports']))
        self.assertEqual([m['source'] for m in config['services']['app']['volumes']], [str(work / 'data'), str(work / 'letsencrypt')])
        self.assertTrue(all(not m['bind']['create_host_path'] for service in config['services'].values() for m in service.get('volumes', [])))
        self.assertEqual(config['services']['ui']['network_mode'], 'service:app')
        self.assertFalse(any('container_name' in s for s in config['services'].values()))

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


if __name__ == '__main__':
    unittest.main()
