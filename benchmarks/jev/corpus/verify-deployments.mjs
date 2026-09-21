import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareRuntime } from './runtime-match.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { 'fetch-compilers': { type: 'boolean' }, write: { type: 'boolean' } } });
const json = p => JSON.parse(readFileSync(join(root, p), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lock = json('sources.lock.json');
// Verify retained inputs before interpreting them. Report writes are explicit;
// normal verification is offline and does not modify the saved evidence.
for (const f of lock.evidenceFiles) {
  if (values.write && f.path === 'evidence/runtime-comparisons.json') continue;
  if (sha256(readFileSync(join(root, f.path))) !== f.sha256) throw new Error(`Evidence hash mismatch: ${f.path}`);
}
const require = createRequire(import.meta.url);
const wrapper = require(join(root, 'cache/compiler/node_modules/solc/wrapper'));
const compilerManifest = json('evidence/compilers.json');
const compilers = new Map();
for (const pin of compilerManifest.compilers) {
  const file = join(root, `cache/compiler/soljson-v${pin.version}.cjs`);
  if (!existsSync(file)) {
    if (!values['fetch-compilers']) throw new Error(`Missing compiler ${pin.version}; use --fetch-compilers`);
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Compiler download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== pin.sha256) throw new Error('Compiler download hash mismatch');
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
  }
  if (sha256(readFileSync(file)) !== pin.sha256) throw new Error(`Compiler hash mismatch: ${pin.version}`);
  compilers.set(pin.version, wrapper(require(file)));
}
const results = [];
for (const job of json('evidence/deployment-jobs.json').jobs) {
  const input = json(job.input);
  input.settings.outputSelection = { '*': { '*': ['evm.deployedBytecode'], '': ['ast'] } };
  const compiler = compilers.get(job.compilerVersion);
  if (!compiler) throw new Error(`Unpinned compiler: ${job.compilerVersion}`);
  const output = JSON.parse(compiler.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const artifact = output.contracts[job.file][job.contractName].evm.deployedBytecode;
  const rpc = json(job.rpcEvidence), deployed = rpc.code[job.addressKey];
  const match = compareRuntime(artifact.object, deployed.bytecode, artifact.immutableReferences);
  if (!match.matchExceptImmutablesAndMetadataDigest) throw new Error(`Runtime mismatch: ${job.id}`);
  const declarations = new Map();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.nodeType === 'VariableDeclaration') declarations.set(String(value.id), value.name);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (typeof child === 'object') visit(child);
    }
  }
  Object.values(output.sources).forEach(s => visit(s.ast));
  for (const immutable of match.immutableValues) immutable.name = declarations.get(immutable.astId);
  const result = {
    id: job.id, address: deployed.address, chainId: rpc.chainId,
    blockNumber: rpc.blockNumber, blockHash: rpc.blockHash,
    contractName: job.contractName, compilerVersion: compiler.version(),
    compilerInputSha256: sha256(readFileSync(join(root, job.input))),
    historicalRuntimeSha256: sha256(Buffer.from(deployed.bytecode.slice(2), 'hex')),
    sourceCount: Object.keys(input.sources).length, ...match,
  };
  results.push(result);
  console.log(`${job.id}: runtime matches${match.metadataDigestOnlyDifference ? ' (metadata digest differs)' : ''}; ${match.immutableValues.length} compiler-declared immutable locations`);
}
const report = {
  methodology: 'Compare retained incident-block runtime with pinned-solc compilation. Record all compiler-declared immutable values. Permit a separately disclosed IPFS metadata digest difference only in the recognized 53-byte Solidity trailer. No exploit execution.',
  results,
};
if (values.write) writeFileSync(join(root, 'evidence/runtime-comparisons.json'), JSON.stringify(report, null, 2) + '\n');
else if (JSON.stringify(report) !== JSON.stringify(json('evidence/runtime-comparisons.json'))) throw new Error('Recompilation differs from saved report');
console.log(`Verified ${results.length} historical contract runtimes. Exploit reproductions were not rerun.`);
