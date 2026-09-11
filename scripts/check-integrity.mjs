import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import assert from 'node:assert/strict';
const upstream = resolve(process.argv[2] || '.cache/upstream/frontend');
const built = resolve('.build/frontend');
const patches = JSON.parse(readFileSync('branding/patches.json'));
const allowed = new Set(patches.map(p => p.file));
let count = 0;
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else {
      const name = relative(upstream, file).replaceAll('\\', '/');
      if (allowed.has(name)) continue;
      assert(existsSync(join(built, name)), `Missing ${name}`);
      assert.deepEqual(readFileSync(join(built, name)), readFileSync(file), `Unexpected upstream change: ${name}`);
      count++;
    }
  }
}
visit(join(upstream, 'src'));
assert.deepEqual(readFileSync(join(upstream, 'yarn.lock')), readFileSync(join(built, 'yarn.lock')));
const docker = readFileSync('Dockerfile', 'utf8');
const lock = JSON.parse(readFileSync('upstream.lock.json'));
assert(docker.includes(`FROM ${lock.image}\n`));
assert(docker.includes(`FROM ${lock.builder} AS frontend`));
console.log(`PASS: ${count} upstream source files byte-identical; dependency lock and image digests verified.`);
