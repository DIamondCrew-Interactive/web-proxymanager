#!/usr/bin/env python3
"""Scan and package an explicit source allowlist; never publish the production snapshot."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ['.gitignore', '.gitattributes', '.dockerignore', 'Dockerfile', 'README.md', 'upstream.lock.json',
         'package.json', 'package-lock.json', 'playwright.config.mjs', 'LICENSE.upstream']
DIRS = ['branding', 'scripts', 'tests', 'docs', 'deploy', 'release']
FORBIDDEN = {'.pem', '.key', '.p12', '.pfx', '.db', '.sqlite', '.sqlite3'}


def shipping_files():
    result = [ROOT / name for name in FILES if (ROOT / name).is_file()]
    for name in DIRS:
        result += [p for p in (ROOT / name).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    for path in result:
        if path.is_symlink() or path.suffix.lower() in FORBIDDEN or path.name.startswith('.env') or 'node_modules' in path.parts:
            raise RuntimeError(f'Forbidden package member: {path.relative_to(ROOT)}')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gitleaks', default='gitleaks')
    parser.add_argument('--package', action='store_true')
    args = parser.parse_args()
    (ROOT / '.build').mkdir(exist_ok=True)
    files = shipping_files()
    with tempfile.TemporaryDirectory(prefix='shipping-', dir=ROOT / '.build') as temp:
        stage = Path(temp)
        for path in files:
            target = stage / path.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        report = ROOT / '.build/source-secret-scan.json'
        result = subprocess.run([args.gitleaks, 'dir', str(stage), '--redact', '--no-banner', '--report-format', 'json',
                                 '--report-path', str(report), '--log-level', 'error'])
        if result.returncode:
            raise SystemExit('Secret scan failed. See the local redacted report; no package created.')
        manifest = {str(p.relative_to(ROOT)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
        (ROOT / '.build/source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print(f'PASS: Gitleaks; {len(files)} allowlisted files, no secret findings or forbidden data files.')
        if args.package:
            package = ROOT / '.build/diamondcrew-proxy-manager-source.zip'
            with zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as archive:
                for path in files:
                    archive.write(path, path.relative_to(ROOT))
            package.with_name(package.name + '.sha256').write_text(hashlib.sha256(package.read_bytes()).hexdigest() + '  ' + package.name + '\n')
            print('Created .build/diamondcrew-proxy-manager-source.zip (source only).')


if __name__ == '__main__':
    main()
