import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ops', Path(__file__).resolve().parents[1] / 'scripts/ops.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class OperationsTests(unittest.TestCase):
    def fixture(self, folder):
        config = {'name': 'production', 'services': {'app': {'image': 'stock', 'volumes': [{'type': 'bind', 'source': '/data-original', 'target': '/data'}]}}}
        path = folder / 'compose.resolved.json'
        path.write_text(json.dumps(config))
        manifest = {'service': 'app', 'stock': 'saved-stock:123', 'imageId': 'sha256:stock', 'sha256': {'compose.resolved.json': hashlib.sha256(path.read_bytes()).hexdigest()}}
        (folder / 'backup.json').write_text(json.dumps(manifest))
        return config

    def test_checksum_failure_prevents_docker_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            self.fixture(folder)
            (folder / 'compose.resolved.json').write_text('{}')
            with patch.object(ops, 'run') as run, self.assertRaisesRegex(RuntimeError, 'checksum'):
                ops.switch(argparse.Namespace(action='deploy', backup=folder, image='custom'))
            run.assert_not_called()

    def test_wrong_version_prevents_recreate(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            self.fixture(folder)
            with patch.object(ops, 'run', return_value=json.dumps([{'Config': {'Labels': {}}}])) as run, self.assertRaisesRegex(RuntimeError, 'upstream version'):
                ops.switch(argparse.Namespace(action='deploy', backup=folder, image='custom'))
            self.assertEqual(run.call_count, 1)

    def test_only_image_may_change(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            config = self.fixture(folder)
            config['services']['app']['volumes'][0]['source'] = '/wrong-data'
            candidate = [{'Id': 'sha256:custom', 'Config': {'Labels': {'net.diamondcrew.upstream.version': ops.LOCK['version']}}}]
            with patch.object(ops, 'run', side_effect=[json.dumps(candidate), json.dumps(config)]) as run, self.assertRaisesRegex(RuntimeError, 'beyond the image'):
                ops.switch(argparse.Namespace(action='deploy', backup=folder, image='custom'))
            self.assertFalse(any('up' in call.args for call in run.call_args_list))

    def test_rollback_uses_saved_image_and_never_restores_old_data(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            config = self.fixture(folder)
            candidate = [{'Id': 'sha256:stock'}]
            calls = []
            def fake(*args, **kwargs):
                calls.append(args)
                if 'inspect' in args: return json.dumps(candidate)
                if 'config' in args: return json.dumps(config)
                return ''
            with patch.object(ops, 'run', side_effect=fake):
                ops.switch(argparse.Namespace(action='rollback', backup=folder))
            self.assertTrue(any('load' in c for c in calls))
            up = next(c for c in calls if 'up' in c)
            self.assertIn('--no-deps', up)
            self.assertIn('--pull', up)
            self.assertFalse(any('down' in c or 'tar' in c for c in calls))
            override = json.loads((folder / 'rollback.override.json').read_text())
            self.assertEqual(override['services']['app']['image'], 'sha256:stock')

    def test_backup_inside_repository_is_rejected(self):
        with patch.object(Path, 'resolve', side_effect=[Path('/compose.yml'), ops.ROOT / 'private-backup']), patch.object(ops, 'run') as run, self.assertRaisesRegex(RuntimeError, 'outside'):
            ops.backup(argparse.Namespace(compose=Path('/compose.yml'), backup=Path('private-backup'), service='app'))
        run.assert_not_called()

    def test_backup_restarts_service_when_archive_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            config = folder / 'compose.yml'
            config.write_text('services: {}')
            data = folder / 'data'
            certificates = folder / 'letsencrypt'
            data.mkdir()
            certificates.mkdir()
            inspect = {'Image': ops.LOCK['snapshotImageId'], 'Config': {'Env': []}, 'Mounts': [
                {'Destination': '/data', 'Type': 'bind', 'Source': str(data)},
                {'Destination': '/etc/letsencrypt', 'Type': 'bind', 'Source': str(certificates)}]}
            compose_calls = []
            def fake_compose(config, *args):
                compose_calls.append(args)
                if args[0] == 'config': return '{"services":{"app":{}}}'
                if args[0] == 'ps': return 'container'
                return ''
            def fake_run(*args):
                if 'inspect' in args: return json.dumps([inspect])
                if args[0] == 'tar': raise RuntimeError('archive failure')
                return ''
            with patch.object(ops, 'run', side_effect=fake_run), patch.object(ops, 'compose', side_effect=fake_compose), self.assertRaisesRegex(RuntimeError, 'archive failure'):
                ops.backup(argparse.Namespace(compose=config, backup=folder / 'backup', service='app'))
            self.assertIn(('stop', 'app'), compose_calls)
            self.assertEqual(compose_calls[-1], ('start', 'app'))
            self.assertFalse((folder / 'backup/backup.json').exists())


if __name__ == '__main__':
    unittest.main()
