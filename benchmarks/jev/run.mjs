import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MODEL, ENDPOINT, INPUT_PRICE, QUESTIONS, hash, Budget, baseline, baselineEffects, requestBody, baselineGroups, predictedGroups, groupErrors } from './core.mjs';
import { decide } from './client.mjs';
import { writeReport } from './report.mjs';

const { values } = parseArgs({ options: {
  out: { type: 'string' }, budget: { type: 'string', default: '1' }, offline: { type: 'boolean', default: false },
  'report-only': { type: 'boolean', default: false },
} });
const root = fileURLToPath(new URL('../../', import.meta.url));
const rawFixtures = readFileSync(new URL('./fixtures/cases.json', import.meta.url), 'utf8');
const fixture = JSON.parse(rawFixtures);
const out = resolve(values.out ?? join(root, 'benchmarks/jev/runs', new Date().toISOString().replaceAll(':', '-')));
const budget = new Budget(Number(values.budget));
const signature = hash({ fixture: hash(rawFixtures), questions: QUESTIONS, model: MODEL, protocol: 1 });
const key = process.env.OPENROUTER_API_KEY;
if (!values.offline && !values['report-only'] && !key) throw new Error('Set OPENROUTER_API_KEY in the environment; it is never written to results.');
mkdirSync(out, { recursive: true });
const manifestPath = join(out, 'manifest.json');
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath));
  if (m.signature !== signature) throw new Error('Run manifest does not match frozen fixtures/prompts/model');
  if (m.offline !== values.offline && !values['report-only']) throw new Error('Use a fresh directory when switching between offline and live');
  if (!values['report-only']) {
    for (const [file, digest] of Object.entries(m.sourceHashes)) {
      if (hash(readFileSync(join(root, file), 'utf8')) !== digest) throw new Error(`Source changed since this run: ${file}. Use a new run directory or --report-only.`);
    }
    if (budget.limit !== m.budget) throw new Error('Resume with the original --budget value');
  }
} else {
  let commit = 'unknown';
  try { commit = execFileSync(process.platform === 'darwin' ? '/Library/Developer/CommandLineTools/usr/bin/git' : 'git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
  const files = ['core.mjs', 'client.mjs', 'run.mjs', 'report.mjs'];
  const baselineFiles = ['src/threat-model/providers/filters/dedup.ts', 'src/threat-model/providers/filters/self-contradiction.ts'];
  writeFileSync(manifestPath, JSON.stringify({ startedAt: new Date().toISOString(), signature, fixtureSha256: hash(rawFixtures), promptSha256: hash(QUESTIONS), questions: QUESTIONS, model: MODEL, endpoint: ENDPOINT, inputPrice: INPUT_PRICE, budget: budget.limit, offline: values.offline, commit, node: process.version, sourceHashes: Object.fromEntries([...files.map(f => `benchmarks/jev/${f}`), ...baselineFiles].map(f => [f, hash(readFileSync(join(root, f), 'utf8'))])), design: '30 dev + 90 test per task; three repeats; repeat 0 concurrency 1, repeats 1/2 concurrency 4; grouping probes separate from primary scores; provisional assistant-curated labels.' }, null, 2) + '\n');
}
const loadLines = name => existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const append = (name, row) => appendFileSync(join(out, name), JSON.stringify(row) + '\n');
const rows = loadLines('predictions.jsonl');
const attemptLog = loadLines('attempts.jsonl');
budget.spent = attemptLog.reduce((s, a) => s + a.budgetCost, 0);
const completed = new Set(rows.map(r => `${r.phase}:${r.id}:${r.repeat}`));
let lockedModel = rows.find(r => r.model)?.model;
let abort = false;
async function infer(c, repeat, phase, concurrency) {
  const job = `${phase}:${c.id}:${repeat}`;
  if (completed.has(job)) return;
  if (abort) return;
  const body = requestBody(c);
  // UTF-8 bytes conservatively exceed tokens for these English/JSON fixtures.
  if (Buffer.byteLength(JSON.stringify(body)) > 28_000) throw new Error(`Case ${c.id} needs explicit context-size review`);
  let result;
  try {
    result = await decide(body, c.task, { key, budget, onAttempt: a => append('attempts.jsonl', { id: c.id, task: c.task, phase, repeat, ...a }) });
  } catch (e) {
    abort = true;
    append('failures.jsonl', { id: c.id, repeat, phase, error: e.message, fatal: true });
    throw e;
  }
  if (result.model && lockedModel && result.model !== lockedModel) { abort = true; throw new Error('Resolved model changed mid-run; do not pool versions'); }
  if (result.model) lockedModel = result.model;
  const { attempts, ...decision } = result;
  const row = { id: c.id, task: c.task, split: c.split, family: c.family, cluster: c.cluster, origin: c.origin, label: c.label, repeat, phase, concurrency, requestSha256: hash(body), ...decision, attempts: attempts.length, billedCost: attempts.reduce((s, a) => s + (a.billedCost ?? 0), 0), unknownBillingAttempts: attempts.filter(a => a.billedCost == null).length, budgetCost: attempts.reduce((s, a) => s + a.budgetCost, 0) };
  rows.push(row); append('predictions.jsonl', row); completed.add(job);
  if (rows.length % 30 === 0) console.log(`${rows.length} decisions recorded; billed $${rows.reduce((s, r) => s + r.billedCost, 0).toFixed(6)}; budget accounting $${budget.spent.toFixed(6)}`);
}
async function pool(jobs, concurrency) {
  let next = 0;
  const started = performance.now();
  const results = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length && !abort) { const job = jobs[next++]; await infer(...job, concurrency); }
  }));
  append('timings.jsonl', { phase: jobs[0]?.[2], repeat: jobs[0]?.[1], concurrency, jobs: jobs.length, elapsedMs: performance.now() - started, resumed: jobs.some(([c, r, phase]) => attemptLog.some(a => a.id === c.id && a.repeat === r && a.phase === phase)) });
  const failure = results.find(r => r.status === 'rejected');
  if (failure) throw failure.reason;
}
if (!values['report-only']) {
  const baselineRows = fixture.cases.map(c => ({ id: c.id, task: c.task, split: c.split, family: c.family, cluster: c.cluster, origin: c.origin, label: c.label, ...baseline(c), effects: baselineEffects(c) }));
  writeFileSync(join(out, 'baseline.json'), JSON.stringify(baselineRows, null, 2) + '\n');
  if (!values.offline) {
    const smoke = { id: 'smoke', task: 'contradiction', split: 'smoke', origin: 'constructed', family: 'smoke', cluster: 'smoke', label: 'retracts', input: { finding: { description: 'This suspected issue is a false positive. The operation is actually safe.', attackScenario: '' } } };
    await pool([[smoke, 0, 'smoke']], 1);
    if (!rows.find(r => r.id === 'smoke')?.prediction) throw new Error('Endpoint smoke test failed');
    // Prompts and labels are already frozen. Development results are not used
    // to edit either within this run. Deterministic shuffle removes task blocks.
    for (let repeat = 0; repeat < 3; repeat++) {
      const ordered = [...fixture.cases].sort((a, b) => hash(`${repeat}:${a.id}`).localeCompare(hash(`${repeat}:${b.id}`)));
      await pool(ordered.filter(c => !completed.has(`main:${c.id}:${repeat}`)).map(c => [c, repeat, 'main']), repeat === 0 ? 1 : 4);
    }
    // Ordered pairs: verify that swapping finding order does not alter groups.
    const pairCases = fixture.groups.flatMap(g => g.findings.flatMap(a => g.findings.filter(b => a.id !== b.id).map(b => ({
      id: `${g.id}:${a.id}:${b.id}`, task: 'dedup', split: g.split, family: g.family, cluster: g.family, origin: 'constructed', label: g.goldClusters.some(k => k.includes(a.id) && k.includes(b.id)) ? 'same' : 'distinct', input: { findings: [a, b] },
    }))));
    await pool(pairCases.filter(c => !completed.has(`group:${c.id}:0`)).map(c => [c, 0, 'group']), 4);
  }
}
const permutations = a => a.length === 0 ? [[]] : a.flatMap((x, i) => permutations(a.filter((_, j) => i !== j)).map(p => [x, ...p]));
const groups = fixture.groups.map(g => ({ id: g.id, gold: g.goldClusters, orders: permutations(g.findings).map(order => {
  const decisions = {};
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) decisions[[order[i].id, order[j].id].sort().join('|')] = rows.find(r => r.phase === 'group' && r.id === `${g.id}:${order[i].id}:${order[j].id}`)?.prediction;
  const pairRecords = Object.keys(decisions).length;
  const missingDecisions = Object.values(decisions).filter(d => !d).length;
  const b = baselineGroups(order), j = missingDecisions === pairRecords ? null : predictedGroups(order, decisions);
  return { order: order.map(f => f.id), missingDecisions, baseline: b, baselineErrors: groupErrors(b, g.goldClusters), jev: j, jevErrors: j ? groupErrors(j, g.goldClusters) : null };
}) }));
writeFileSync(join(out, 'groups.json'), JSON.stringify(groups, null, 2) + '\n');
writeReport(out, fixture);
console.log(`Results: ${out}`);
