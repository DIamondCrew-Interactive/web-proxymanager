#!/usr/bin/env python3
"""DIA-01 maintenance, invoked manually on Linux. Never contacts a remote host."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'upstream.lock.json').read_text())


def run(*args, capture=True):
    return subprocess.check_output(args, text=True).strip() if capture else subprocess.run(args, check=True)


def save(path, obj):
    path.write_text(json.dumps(obj, indent=2) + '\n')
    path.chmod(0o600)


def compose(config, *args):
    return run('docker', 'compose', '-f', str(config), *args)


def backup(args):
    config = args.compose.resolve(strict=True)
    destination = args.backup.resolve()
    if destination == ROOT or ROOT in destination.parents:
        raise RuntimeError('Backup must be outside the repository (contains production secrets)')
    if destination.exists():
        raise RuntimeError('Use a new backup directory')
    resolved = json.loads(compose(config, 'config', '--format', 'json'))
    cid = compose(config, 'ps', '-q', args.service)
    if not cid or '\n' in cid:
        raise RuntimeError('Exactly one running service container is required')
    inspect = json.loads(run('docker', 'inspect', cid))[0]
    if inspect['Image'] != LOCK['snapshotImageId']:
        raise RuntimeError('Running image differs from verified stock snapshot; audit the version before backup')
    if any(e.split('=', 1)[0].startswith(('DB_MYSQL_', 'DB_POSTGRES_')) for e in inspect['Config']['Env']):
        raise RuntimeError('External database detected: arrange a consistent native DB dump and adapt backup procedure first')
    mounts = {m['Destination']: m for m in inspect['Mounts']}
    for target in ('/data', '/etc/letsencrypt'):
        if target not in mounts or mounts[target]['Type'] != 'bind' or not Path(mounts[target]['Source']).is_dir():
            raise RuntimeError('This backup procedure requires the verified local bind mounts')
    destination.mkdir(parents=True, mode=0o700)
    stock = 'diamondcrew-stock-backup:' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')
    run('docker', 'tag', inspect['Image'], stock)
    save(destination / 'compose.resolved.json', resolved)
    save(destination / 'container.inspect.json', inspect)
    (destination / 'compose.original.yml').write_bytes(config.read_bytes())
    run('docker', 'image', 'save', '-o', str(destination / 'stock-image.tar'), stock)
    # Stop writes for a consistent SQLite + certificates + generated config snapshot.
    compose(config, 'stop', args.service)
    try:
        for target, archive in [('/data', 'data.tar'), ('/etc/letsencrypt', 'letsencrypt.tar')]:
            run('tar', '--acls', '--xattrs', '--numeric-owner', '-cpf', str(destination / archive), '-C', mounts[target]['Source'], '.')
    finally:
        compose(config, 'start', args.service)
    hashes = {}
    for name in ('stock-image.tar', 'data.tar', 'letsencrypt.tar', 'compose.resolved.json', 'container.inspect.json', 'compose.original.yml'):
        with (destination / name).open('rb') as stream:
            hashes[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    save(destination / 'backup.json', {'service': args.service, 'stock': stock, 'imageId': inspect['Image'], 'sha256': hashes})
    print(f'Backup complete: {destination}. Keep this directory private and copy it off-host securely.')


def switch(args):
    destination = args.backup.resolve(strict=True)
    manifest = json.loads((destination / 'backup.json').read_text())
    for name, expected in manifest['sha256'].items():
        with (destination / name).open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                raise RuntimeError(f'Backup checksum mismatch: {name}')
    config = destination / 'compose.resolved.json'
    service = manifest['service']
    image = manifest['stock'] if args.action == 'rollback' else args.image
    if args.action == 'rollback':
        run('docker', 'image', 'load', '-i', str(destination / 'stock-image.tar'))
    candidate = json.loads(run('docker', 'image', 'inspect', image))[0]
    if args.action == 'rollback':
        if candidate['Id'] != manifest['imageId']:
            raise RuntimeError('Saved stock image ID mismatch')
    elif candidate.get('Config', {}).get('Labels', {}).get('net.diamondcrew.upstream.version') != LOCK['version']:
        raise RuntimeError('Custom image must declare the verified upstream version')
    # Pin the local image ID, so an image tag cannot move between check and recreate.
    override = destination / f'{args.action}.override.json'
    save(override, {'services': {service: {'image': candidate['Id'], 'pull_policy': 'never'}}})
    before = json.loads(config.read_text())
    command = ['docker', 'compose', '-f', str(config), '-f', str(override)]
    after = json.loads(run(*command, 'config', '--format', 'json'))
    for obj in (before, after):
        obj['services'][service].pop('image', None)
        obj['services'][service].pop('pull_policy', None)
    if before != after:
        raise RuntimeError('Compose changed beyond the image; refusing to recreate')
    # Refuse to overwrite changes made to the running service after this backup.
    cid = compose(config, 'ps', '-q', service)
    if cid:
        current = json.loads(run('docker', 'inspect', cid))[0]
        saved = json.loads((destination / 'container.inspect.json').read_text())
        def signature(c):
            return {'mounts': sorted((m['Type'], m['Source'], m['Destination'], m.get('RW')) for m in c['Mounts']),
                    'env': sorted(c['Config']['Env']), 'ports': c['HostConfig']['PortBindings'],
                    'networks': sorted(c['NetworkSettings']['Networks'])}
        if signature(current) != signature(saved):
            raise RuntimeError('Running mounts/environment/ports/networks changed since backup; audit before proceeding')
    run(*command, 'up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', service, capture=False)
    print('Image switched. Perform the acceptance checklist in docs/VALIDATION.md.')
    print(f'For future Compose operations use: docker compose -f {config} -f {override}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    b = sub.add_parser('backup')
    b.add_argument('--compose', type=Path, required=True)
    b.add_argument('--service', default='app')
    b.add_argument('--backup', type=Path, required=True)
    d = sub.add_parser('deploy')
    d.add_argument('--backup', type=Path, required=True)
    d.add_argument('--image', required=True)
    r = sub.add_parser('rollback')
    r.add_argument('--backup', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'linux':
        parser.error('Run manually on the Linux Docker host; this script does not deploy remotely')
    os.umask(0o077)
    backup(args) if args.action == 'backup' else switch(args)


if __name__ == '__main__':
    main()
