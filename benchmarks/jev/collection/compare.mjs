import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { hash, baseline, baselineEffects, requestBody, Budget, quantile, MODEL, QUESTIONS } from '../core.mjs';
import { decide } from '../client.mjs';
const { values } = parseArgs({ options: { cases: { type: 'string' }, out: { type: 'string' }, offline: { type: 'boolean' }, 'provisional-labels': { type: 'string' } } });
if (!values.cases || !values.out) throw new Error('--cases and --out are required');
const dataset = JSON.parse(readFileSync(resolve(values.cases)));
if (dataset.cases.some(c => c.label !== null)) throw new Error('This command is for unlabeled shadow comparison only');
const out = resolve(values.out); mkdirSync(out, { recursive: true });
if (existsSync(join(out, 'manifest.json'))) throw new Error('Choose a new comparison directory; do not overwrite an experiment');
if (!values.offline && !process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required');
const manifest = { version: 1, startedAt: new Date().toISOString(), datasetSha256: hash(JSON.stringify(dataset)), model: MODEL, questions: QUESTIONS, mode: values.offline ? 'offline' : 'shadow', budgetUsd: 1, repeats: 1, labeled: false, accuracy: null };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (values['provisional-labels']) {
  const labels = JSON.parse(readFileSync(resolve(values['provisional-labels'])));
  if (labels.datasetSha256 !== manifest.datasetSha256 || labels.reviewer?.kind !== 'assistant' || labels.reviewer?.independent !== false) throw new Error('Expected provisional assistant labels for this dataset');
  if (!(Date.parse(labels.createdAt) <= Date.parse(manifest.startedAt))) throw new Error('Labels must precede comparison');
  manifest.provisionalLabelsSha256 = hash(JSON.stringify(labels));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
const budget = new Budget(1), rows = [];
let modelVersion;
for (const c of dataset.cases) {
  const row = { id: c.id, task: c.task, project: c.project, baseline: baseline(c), baselineEffects: baselineEffects(c) };
  if (!values.offline) {
    try {
      row.jev = await decide(requestBody(c), c.task, { key: process.env.OPENROUTER_API_KEY, budget, onAttempt: a => appendFileSync(join(out, 'attempts.jsonl'), JSON.stringify({ caseId: c.id, ...a }) + '\n') });
      if (row.jev.model && modelVersion && row.jev.model !== modelVersion) throw new Error('Served model changed during comparison');
      modelVersion ??= row.jev.model;
    } catch (error) {
      row.error = error.fatal ? 'fatal-api-error' : 'comparison-stopped';
      appendFileSync(join(out, 'predictions.jsonl'), JSON.stringify(row) + '\n');
      throw error;
    }
  }
  rows.push(row); appendFileSync(join(out, 'predictions.jsonl'), JSON.stringify(row) + '\n');
}
const summary = { version: 1, accuracy: null, reason: 'Independent labels are pending. Agreement is not accuracy.', cases: rows.length, completedAt: new Date().toISOString(), servedModel: modelVersion ?? null,
  budgetChargedUsd: budget.spent, billedCostUsd: rows.reduce((s, r) => s + (r.jev?.attempts || []).reduce((n, a) => n + (a.billedCost ?? 0), 0), 0),
  unknownBillingAttempts: rows.flatMap(r => r.jev?.attempts || []).filter(a => a.billedCost === null).length,
  tasks: Object.fromEntries(['contradiction', 'dedup'].map(task => { const rs = rows.filter(r => r.task === task), decided = rs.filter(r => r.jev?.prediction); return [task, { n: rs.length, decisions: decided.length, disagreements: decided.filter(r => r.baseline.prediction !== r.jev.prediction).map(r => r.id), errors: values.offline ? 0 : rs.length - decided.length,
    baselineActions: rs.filter(r => r.baseline.prediction === (task === 'dedup' ? 'same' : 'retracts')).length,
    jevActions: decided.filter(r => r.jev.prediction === (task === 'dedup' ? 'same' : 'retracts')).length,
    abstentions: decided.filter(r => ['unresolved', 'insufficient'].includes(r.jev.prediction)).length,
    p50LatencyMs: quantile(decided.map(r => r.jev.latencyMs), 0.5), p95LatencyMs: quantile(decided.map(r => r.jev.latencyMs), 0.95) }]; })) };
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
