import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, lstatSync, mkdtempSync, renameSync, rmSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'sources.lock.json'), 'utf8'));
const { values } = parseArgs({ options: { verify: { type: 'boolean' }, assemble: { type: 'boolean' }, only: { type: 'string' } } });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function requireHash(file, expected) {
  if (sha256(readFileSync(file)) !== expected) throw new Error(`SHA-256 mismatch: ${file}`);
}
function verifySource(directory, repository) {
  const expected = new Map(repository.inventory.map(f => [f.path, f]));
  if (expected.size !== repository.inventory.length) throw new Error(`Overlapping source inventories: ${repository.id}`);
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

const selected = lock.repositories.filter(r => !values.only || r.id === values.only);
if (!selected.length) throw new Error('Unknown repository ID');
const byId = new Map(lock.repositories.map(r => [r.id, r]));
const required = new Set();
function include(r, ancestry = []) {
  if (!r) throw new Error('Missing pinned dependency');
  if (ancestry.includes(r.id)) throw new Error('Cyclic dependency pins');
  required.add(r.id);
  for (const sub of r.submodules) {
    const dependency = byId.get(sub.repositoryId);
    if (!dependency || dependency.commit !== sub.commit) throw new Error(`Dependency pin mismatch: ${r.id}/${sub.path}`);
    include(dependency, [...ancestry, r.id]);
  }
}
selected.forEach(r => include(r));
const repositories = lock.repositories.filter(r => required.has(r.id));
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
  console.log(`${r.id}: verified ${r.inventory.length} files at ${r.commit}`);
}
for (const f of lock.evidenceFiles) requireHash(join(root, f.path), f.sha256);

// Assemble copies, preserving the original snapshots and each parent's exact
// submodule pin. These workspaces still contain upstream tests/documentation;
// they are provenance/build workspaces, not leak-free analyzer inputs.
function workspaceFiles(r, prefix = '') {
  return [...r.inventory.map(f => ({ ...f, path: join(prefix, f.path) })),
    ...r.submodules.flatMap(s => workspaceFiles(byId.get(s.repositoryId), join(prefix, s.path)))];
}
function copyRepository(r, destination) {
  cpSync(resolve(root, r.cacheDirectory), destination, { recursive: true });
  for (const sub of r.submodules) copyRepository(byId.get(sub.repositoryId), join(destination, sub.path));
}
for (const r of selected.filter(r => r.submodules.length)) {
  const destination = join(root, 'cache', 'workspaces', r.id);
  const assembled = { id: r.id, inventory: workspaceFiles(r) };
  if (values.assemble && !existsSync(destination)) {
    if (values.verify) throw new Error(`Workspace not assembled: ${r.id}`);
    mkdirSync(dirname(destination), { recursive: true });
    const temp = mkdtempSync(join(dirname(destination), 'assemble-'));
    try {
      copyRepository(r, temp);
      verifySource(temp, assembled);
      renameSync(temp, destination);
    } finally { if (existsSync(temp)) rmSync(temp, { recursive: true }); }
  }
  if (existsSync(destination)) {
    verifySource(destination, assembled);
    console.log(`${r.id}: verified assembled workspace (${assembled.inventory.length} files)`);
  }
}
for (const comparison of JSON.parse(readFileSync(join(root, 'evidence/source-correspondence.json'), 'utf8')).comparisons) {
  if (!comparison.repositoryId) continue;
  const r = byId.get(comparison.repositoryId);
  const files = new Map(workspaceFiles(r).map(f => [f.path, f]));
  const input = JSON.parse(readFileSync(join(root, comparison.compilerInput), 'utf8'));
  let matches = 0;
  for (const source of comparison.sources) {
    const digest = sha256(Buffer.from(input.sources[source.path].content));
    const exact = files.get(source.path)?.sha256 === digest;
    if (source.sha256 !== digest || source.exactMatch !== exact) throw new Error(`Source correspondence changed: ${comparison.id}/${source.path}`);
    if (exact) matches++;
  }
  if (matches !== comparison.exactFiles || comparison.sources.length !== comparison.totalFiles) throw new Error(`Source correspondence count changed: ${comparison.id}`);
}
console.log('Source archives, dependency pins, and evidence verified. See sources.lock.json for deployment correspondence; upstream exploit reproductions are trusted by user choice.');
