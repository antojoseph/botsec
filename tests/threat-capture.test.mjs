import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceOnlyHook } from '../dist/threat-model/source-only.js';
let queryOptions;
let response;
mock.module('@anthropic-ai/claude-agent-sdk', { namedExports: { query: async function* (args) {
  queryOptions = args.options;
  yield { type: 'result', subtype: 'success', structured_output: response, result: 'invalid if no structured output' };
} } });
mock.module('../dist/threat-model/precompute.js', { namedExports: { listContracts: () => [], precomputeAnalysis: async projectDir => ({ projectDir, abi: {}, storageLayout: {}, methodIds: {} }) } });
const { generateThreatModel } = await import('../dist/threat-model/orchestrator.js');
const { allProviders } = await import('../dist/threat-model/providers/registry.js');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'threat-capture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'foundry.toml'), '[profile.default]\nsrc="src"\n');
  mkdirSync(join(project, 'src')); writeFileSync(join(project, 'src/C.sol'), 'contract C {}');
  return { dir, project, reports: join(dir, 'reports') };
}
function finding(id, extra = {}) { return { id, title: id, category: 'logic-error', description: 'A defect', affectedCode: ['C.f'], severity: 'High', confidence: 'high', trace: { steps: [{ action: 'read', target: 'C.f', finding: 'defect' }] }, suggestedProperties: [], priority: 1, ...extra }; }
test('captures findings removed and mutated by synthesis without changing normal output', async t => {
  const f = fixture(t);
  response = { contractType: 'other', threats: [finding('a', { description: 'not exploitable; actually safe' }), finding('b'), finding('c', { trace: { steps: [] } })] };
  await generateThreatModel({ contractPath: f.project, outputDir: f.reports, captureRaw: true, sourceOnly: true, enabledProviders: allProviders().filter(p => p.phase === 'synthesis-filter') });
  const run = join(f.reports, readdirSync(f.reports)[0]);
  const raw = JSON.parse(readFileSync(join(run, 'raw-findings.json')));
  assert.equal(raw.threats.length, 3); assert.equal(raw.threats[0].severity, 'High');
  assert.equal(raw.threats[0].claimReview, undefined);
  const reviews = JSON.parse(readFileSync(join(run, 'claim-reviews.json')));
  assert.equal(reviews.length, 3);
  assert.ok(reviews.every(r => r.review.executionVerified === false && r.review.status === 'not-assessed'));
  const inventory = JSON.parse(readFileSync(join(f.project, '.forge-proof/source-index.json')));
  assert.ok(inventory.files.some(f => f.path === 'src/C.sol'));
  const stages = readFileSync(join(run, 'synthesis-stages.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(stages[0].before.length, 3); assert.equal(stages[0].after.length, 2);
  assert.equal(stages[1].after[0].severity, 'Medium');
  assert.equal(stages[2].after.length, 1);
  assert.equal(stages[1].after[1].description, 'A defect');
  assert.equal(JSON.parse(readFileSync(join(run, 'threat-model.json'))).threats.length, 1);
  assert.deepEqual(queryOptions.agents['threat-modeler'].tools, ['Read', 'Grep', 'Glob']);
  assert.ok(queryOptions.hooks.PreToolUse.length);
});
test('parse failure is recorded distinctly from a valid empty finding set', async t => {
  const f = fixture(t); response = undefined;
  await generateThreatModel({ contractPath: f.project, outputDir: f.reports, captureRaw: true });
  const run = join(f.reports, readdirSync(f.reports)[0]);
  assert.equal(JSON.parse(readFileSync(join(run, 'generation-result.json'))).parseSucceeded, false);
});
test('source-only hooks reject external reads, traversal, symlinks, shell and other agents', async t => {
  const f = fixture(t), hook = sourceOnlyHook(f.project);
  const decision = async (tool_name, tool_input) => (await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input }, undefined, {})).hookSpecificOutput.permissionDecision;
  assert.equal(await decision('Read', { file_path: join(f.project, 'src/C.sol') }), 'allow');
  assert.equal(await decision('Read', { file_path: '/etc/passwd' }), 'deny');
  assert.equal(await decision('Glob', { pattern: '../**/*' }), 'deny');
  assert.equal(await decision('Bash', { command: 'cat /etc/passwd' }), 'deny');
  assert.equal(await decision('Task', { subagent_type: 'Explore' }), 'deny');
  assert.equal(await decision('Task', { subagent_type: 'threat-modeler', run_in_background: true }), 'deny');
  symlinkSync('/etc', join(f.project, 'outside'));
  assert.throws(() => sourceOnlyHook(f.project), /symlinks/);
});
