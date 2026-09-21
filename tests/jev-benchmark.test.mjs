import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Budget, baseline, baselineEffects, metrics, parseResponse, requestBody, predictedGroups, groupErrors, pairedInterval } from '../benchmarks/jev/core.mjs';
import { decide } from '../benchmarks/jev/client.mjs';

const fixture = JSON.parse(readFileSync(new URL('../benchmarks/jev/fixtures/cases.json', import.meta.url)));
const sample = { model: 'typesafe/jev-1.13-20260917', answers: { review: { type: 'choice', choice: 'maintains', confidence: 0.8, probabilities: { maintains: 0.9, retracts: 0.05, unresolved: 0.05 } } }, usage: { input_tokens: 100, output_tokens: 30, cost: 0.0000042 } };
test('benchmark freezes exact counts, distinct development families, and labels outside model inputs', () => {
  assert.equal(new Set(fixture.cases.map(c => c.id)).size, 240);
  for (const task of ['contradiction', 'dedup']) {
    assert.equal(fixture.cases.filter(c => c.task === task && c.split === 'dev').length, 30);
    assert.equal(fixture.cases.filter(c => c.task === task && c.split === 'test').length, 90);
  }
  const dev = new Set(fixture.cases.filter(c => c.split === 'dev').map(c => c.family));
  for (const c of fixture.cases) {
    if (c.split === 'test') assert.ok(!dev.has(c.family));
    const body = requestBody(c);
    assert.ok(!('label' in body.state));
    assert.ok(!('rationale' in body.state));
    assert.ok(!JSON.stringify(body.state).includes(c.rationale));
  }
});
test('actual baseline catches pattern but has known negation and semantic misses without mutating fixtures', () => {
  const c = structuredClone(fixture.cases.find(c => c.task === 'contradiction'));
  c.input.finding.description = 'The bug is not a false positive: anyone can drain the pool.';
  const original = structuredClone(c);
  assert.equal(baseline(c).prediction, 'retracts');
  assert.deepEqual(c, original);
  assert.equal(baselineEffects(c).severityAfter, 'Medium');
  c.input.finding.description = 'The caller is rejected before any state change; this allegation is withdrawn.';
  assert.equal(baseline(c).prediction, 'maintains');
});
test('actual dedup baseline merges two distinct mechanisms at the same location', () => {
  const c = fixture.cases.find(c => c.task === 'dedup' && c.tags.includes('same-location-different-defect'));
  assert.equal(c.label, 'distinct');
  assert.equal(baseline(c).prediction, 'same');
});
test('metrics count API errors, harmful merges and abstention without denominator gaming', () => {
  const rows = [
    { label: 'same', prediction: 'same' }, { label: 'distinct', prediction: 'same' },
    { label: 'distinct', prediction: null }, { label: 'insufficient', prediction: 'insufficient' },
  ].map(r => ({ ...r, latencyMs: 1 }));
  const m = metrics(rows, 'dedup');
  assert.equal(m.accuracy, 0.5); assert.equal(m.errors, 1); assert.equal(m.harmfulErrors, 1);
  assert.equal(m.harmfulDenominator, 2); assert.equal(m.clearLabelAccuracy, 1 / 3);
  assert.equal(m.actionCoverage, 0.5); assert.equal(m.selectiveAccuracy, 0.5);
  assert.equal(m.brierScore, null);
});
test('probability metrics use probabilities, not distribution confidence, and reject invalid distributions', () => {
  const parsed = parseResponse(sample, 'contradiction');
  const m = metrics([{ ...parsed, label: 'maintains', latencyMs: 1 }], 'contradiction');
  assert.ok(Math.abs(m.brierScore - 0.015) < 1e-9);
  assert.equal(m.riskCoverage.find(r => r.threshold === 0.9).n, 1);
  assert.throws(() => parseResponse({ ...sample, answers: { review: { type: 'choice', choice: 'made-up' } } }, 'contradiction'));
  assert.throws(() => parseResponse({ ...sample, answers: { review: { ...sample.answers.review, probabilities: { maintains: 1, retracts: 1, unresolved: 0 } } } }, 'contradiction'));
  assert.equal(parseResponse({ ...sample, answers: { review: { type: 'choice', choice: 'maintains' } } }, 'contradiction').probabilities, null);
});
test('budget reservations include concurrent work and charge unknown attempts conservatively', () => {
  const budget = new Budget(0.01), a = budget.reserve(0.006);
  assert.throws(() => budget.reserve(0.005), /budget/);
  a(0.002); const b = budget.reserve(0.006); b();
  assert.ok(Math.abs(budget.spent - 0.008) < 1e-12);
  assert.throws(() => a(0), /already/);
});
test('client honors Retry-After, records all attempt costs and never logs credentials or server text', async () => {
  const budget = new Budget(1), waits = [], logs = []; let n = 0;
  const result = await decide({}, 'contradiction', { key: 'secret-fixture', budget, sleep: async ms => waits.push(ms), onAttempt: a => logs.push(a), fetchFn: async () => ++n === 1 ? new Response(JSON.stringify({ error: 'secret-fixture echoed by server' }), { status: 429, headers: { 'Retry-After': '1' } }) : new Response(JSON.stringify(sample), { status: 200 }) });
  assert.equal(result.prediction, 'maintains'); assert.deepEqual(waits, [1000]); assert.equal(logs.length, 2);
  assert.equal(logs[0].billedCost, null); assert.ok(budget.spent > sample.usage.cost);
  assert.ok(!JSON.stringify(logs).includes('secret-fixture'));
});
test('client stops on auth failures, malformed output and persistent network failure', async () => {
  let n = 0;
  await assert.rejects(decide({}, 'contradiction', { budget: new Budget(), fetchFn: async () => { n++; return new Response('{}', { status: 401 }); } }), /HTTP 401/);
  assert.equal(n, 1);
  await assert.rejects(decide({}, 'contradiction', { budget: new Budget(), fetchFn: async () => new Response('Not JSON', { status: 401 }) }), /HTTP 401/);
  const bad = await decide({}, 'contradiction', { budget: new Budget(), fetchFn: async () => new Response('{}') });
  assert.equal(bad.prediction, null); assert.equal(bad.attempts.length, 1);
  const down = await decide({}, 'contradiction', { budget: new Budget(), sleep: async () => {}, fetchFn: async () => { throw new Error('private message'); } });
  assert.equal(down.attempts.length, 3); assert.equal(down.error, 'Network failure');
});
test('grouping does not collapse distinct bugs through a transitive duplicate chain', () => {
  const groups = predictedGroups([{ id: 'A' }, { id: 'B' }, { id: 'C' }], { 'A|B': 'same', 'B|C': 'same', 'A|C': 'distinct' });
  assert.deepEqual(groups, [['A', 'B'], ['C']]);
  assert.deepEqual(groupErrors(groups, [['A', 'B'], ['C']]), { falseMerges: 0, missedMerges: 0 });
});
test('paired intervals resample provenance clusters, not repeated cases as independent observations', () => {
  const interval = pairedInterval([{ cluster: 'a', label: 'same', baseline: 'distinct', jev: 'same' }, { cluster: 'b', label: 'same', baseline: 'same', jev: 'same' }]);
  assert.equal(interval.clusters, 2); assert.equal(interval.accuracyDifference, 0.5);
  assert.equal(interval.exploratoryOnly, true);
});
