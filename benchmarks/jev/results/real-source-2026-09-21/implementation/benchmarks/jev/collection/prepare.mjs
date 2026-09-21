import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const corpus = resolve(dirname(fileURLToPath(import.meta.url)), '../corpus');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lock = JSON.parse(readFileSync(join(corpus, 'sources.lock.json')));
const jobs = JSON.parse(readFileSync(join(corpus, 'evidence/deployment-jobs.json'))).jobs;
const evidence = new Map(lock.evidenceFiles.map(f => [f.path, f.sha256]));
const job = id => jobs.find(j => j.id === id);
const definitions = [
  { id: 'project-01', family: 'socket', primary: ['socket-route'], context: ['socket-gateway'] },
  { id: 'project-02', family: 'sentiment', primary: ['sentiment-source'], context: ['sentiment-account-manager-implementation', 'sentiment-balancer-vault', '20210418-weighted-pool'] },
  { id: 'project-03', family: 'euler', primary: ['euler-etoken', 'euler-liquidation', 'euler-riskmanager', 'euler-markets', 'euler-exec', 'euler-dtoken'], context: ['euler-core', 'euler-installer', 'euler-governance'] },
];
const out = resolve(values.out || mkdtempSync(join(tmpdir(), 'jev-collection-')));
mkdirSync(out, { recursive: true });
if (existsSync(join(out, 'preparation.json'))) throw new Error('Refusing to overwrite prepared collection');
const readInput = id => {
  const j = job(id), bytes = readFileSync(join(corpus, j.input));
  if (hash(bytes) !== evidence.get(j.input)) throw new Error(`Unverified compiler input ${id}`);
  return JSON.parse(bytes);
};
const prepared = [];
for (const definition of definitions) {
  const dir = join(out, definition.id); mkdirSync(dir, { recursive: false });
  const inventory = [];
  const written = new Map();
  function source(path, content) {
    if (isAbsolute(path) || path.split('/').some(p => p === '..') || path.includes('\\') || !path.endsWith('.sol')) throw new Error('Unsafe/non-source compiler input path');
    if (written.has(path)) { if (written.get(path) !== content) throw new Error(`Conflicting compilation units at ${path}`); return; }
    written.set(path, content); const dest = join(dir, path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, content, { flag: 'wx' });
    inventory.push({ path, sha256: hash(content), bytes: Buffer.byteLength(content) });
  }
  for (const id of definition.primary) for (const [path, s] of Object.entries(readInput(id).sources)) source(path, s.content);
  for (const [i, id] of definition.context.entries()) for (const [path, s] of Object.entries(readInput(id).sources)) source(`context/unit-${i + 1}/${path}`, s.content);
  const first = job(definition.primary[0]), input = readInput(first.id);
  const src = first.file.split('/')[0];
  const config = `[profile.default]\nsrc = ${JSON.stringify(src)}\ntest = "test"\nscript = "script"\nlibs = ["lib"]\nsolc_version = ${JSON.stringify(first.compilerVersion.split('+')[0])}\noptimizer = ${input.settings.optimizer?.enabled === true}\noptimizer_runs = ${input.settings.optimizer?.runs || 200}\nevm_version = ${JSON.stringify(input.settings.evmVersion || 'london')}\nremappings = ${JSON.stringify(input.settings.remappings || [])}\n`;
  writeFileSync(join(dir, 'foundry.toml'), config);
  prepared.push({ ...definition, directory: dir, inventory: inventory.sort((a, b) => a.path.localeCompare(b.path)), config, configSha256: hash(config), scope: 'Primary compilation sources with separately preserved cross-contract source context; context units are readable but excluded from the primary AST build.' });
}
const manifest = { version: 1, createdAt: new Date().toISOString(), sourceLockSha256: hash(readFileSync(join(corpus, 'sources.lock.json'))), split: 'development-collection; already-selected public incidents, not a held-out test set', projects: prepared };
writeFileSync(join(out, 'preparation.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ manifest: join(out, 'preparation.json'), projects: prepared.map(p => ({ id: p.id, directory: p.directory, files: p.inventory.length })) }, null, 2));
