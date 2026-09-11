import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'upstream.lock.json')));
const upstream = resolve(process.argv[2] || join(root, '.build/upstream'));
const target = join(root, '.build/frontend');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (!existsSync(upstream)) {
  mkdirSync(resolve(upstream, '..'), { recursive: true });
  git('clone', '--depth', '1', '--branch', `v${lock.version}`, lock.repository, upstream);
}
if (git('-C', upstream, 'rev-parse', 'HEAD') !== lock.commit) throw Error('Upstream commit mismatch');
if (git('-C', upstream, 'status', '--porcelain', '--untracked-files=no')) throw Error('Upstream checkout is modified');
if (readFileSync(join(upstream, '.version'), 'utf8').trim() !== lock.version) throw Error('Upstream version mismatch');
mkdirSync(target, { recursive: true });
cpSync(join(upstream, 'frontend'), target, { recursive: true });
const patches = JSON.parse(readFileSync(join(root, 'branding/patches.json')));
for (const patch of patches) {
  const file = join(target, patch.file);
  let source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  if (createHash('sha256').update(source).digest('hex') !== patch.sha256) throw Error(`Changed upstream: ${patch.file}`);
  for (const [before, after] of patch.replacements) {
    if (source.split(before).length !== 2) throw Error(`Patch must match exactly once: ${patch.file}`);
    source = source.replace(before, after);
  }
  writeFileSync(file, source);
}
cpSync(join(root, 'branding/src'), join(target, 'src/diamondcrew'), { recursive: true });
cpSync(join(root, 'branding/public'), join(target, 'public/diamondcrew'), { recursive: true });
cpSync(join(upstream, 'LICENSE'), join(root, '.build/LICENSE.upstream'));
console.log(`Prepared NPM ${lock.version} (${lock.commit}); ${patches.length} guarded presentation patches`);
