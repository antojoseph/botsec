import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, lstatSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'sources.lock.json'), 'utf8'));
const { values } = parseArgs({ options: { verify: { type: 'boolean' }, only: { type: 'string' } } });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function requireHash(file, expected) {
  if (sha256(readFileSync(file)) !== expected) throw new Error(`SHA-256 mismatch: ${file}`);
}
function verifySource(directory, repository) {
  const expected = new Map(repository.inventory.map(f => [f.path, f]));
  const seen = new Set();
  function walk(relative = '') {
    for (const name of readdirSync(join(directory, relative))) {
      const p = join(relative, name), abs = join(directory, p), stat = lstatSync(abs);
      if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink: ${p}`);
      if (stat.isDirectory()) { walk(p); continue; }
      const entry = expected.get(p);
      if (!entry) throw new Error(`Unpinned file in snapshot: ${p}`);
      const bytes = readFileSync(abs);
      const gitBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256 || gitBlob !== entry.gitBlob) throw new Error(`Source differs from pinned Git blob: ${p}`);
      seen.add(p);
    }
  }
  walk();
  if (seen.size !== expected.size) throw new Error(`Missing files in ${repository.id}`);
}

const repositories = lock.repositories.filter(r => !values.only || r.id === values.only);
if (!repositories.length) throw new Error('Unknown repository ID');
for (const r of repositories) {
  const archive = resolve(root, r.archive), destination = resolve(root, r.cacheDirectory);
  if (!existsSync(archive)) {
    if (values.verify) throw new Error(`Missing archive: ${r.archive}`);
    const response = await fetch(r.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Download failed: ${r.id}, HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== r.sha256) throw new Error(`Downloaded archive hash changed: ${r.id}`);
    mkdirSync(dirname(archive), { recursive: true }); writeFileSync(archive, bytes);
  }
  requireHash(archive, r.sha256);
  if (!existsSync(destination)) {
    if (values.verify) throw new Error(`Snapshot not extracted: ${r.cacheDirectory}`);
    // All locked archives contain only regular files and directories. Reject
    // link entries and traversal before extraction; never execute repo scripts.
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    const verbose = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n');
    if (listing.some(p => p.startsWith('/') || p.split('/').includes('..')) || verbose.some(l => !['-', 'd'].includes(l[0]))) throw new Error(`Unsafe archive entries: ${r.id}`);
    mkdirSync(dirname(destination), { recursive: true });
    const temp = mkdtempSync(join(dirname(destination), 'extract-'));
    try {
      execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', temp]);
      verifySource(temp, r);
      renameSync(temp, destination);
    } finally { if (existsSync(temp)) rmSync(temp, { recursive: true }); }
  }
  verifySource(destination, r);
  console.log(`${r.id}: verified ${r.inventory.length} files at ${r.commit}; ${r.submodules.length} pinned submodules not expanded`);
}
for (const f of lock.evidenceFiles) requireHash(join(root, f.path), f.sha256);
console.log('Source archives and evidence verified. Deployment correspondence and exploit reproduction are separate checks; see sources.lock.json.');
