import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { metrics, pairedInterval, quantile } from './core.mjs';
const pct = x => x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
const num = x => x == null ? 'n/a' : x.toFixed(2);
export function writeReport(out, fixture) {
  const lines = name => existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json')));
  const base = JSON.parse(readFileSync(join(out, 'baseline.json')));
  const predictions = lines('predictions.jsonl'), attempts = lines('attempts.jsonl');
  const summary = { manifest, slices: {}, paired: {}, consistency: {}, performance: {}, cost: {}, disagreements: [], grouping: JSON.parse(readFileSync(join(out, 'groups.json'))) };
  const main = predictions.filter(r => r.phase === 'main');
  const primary = main.filter(r => r.repeat === 0);
  for (const task of ['contradiction', 'dedup']) {
    const test = primary.filter(r => r.task === task && r.split === 'test');
    const slices = { dev: c => c.split === 'dev', test: c => c.split === 'test', real: c => c.split === 'test' && c.origin === 'real', constructed: c => c.split === 'test' && c.origin === 'constructed' };
    if (task === 'dedup') {
      const candidateIds = new Set(base.filter(r => r.task === task && r.prediction === 'same').map(r => r.id));
      slices.existingCandidates = c => c.split === 'test' && candidateIds.has(c.id);
      slices.outsideCandidates = c => c.split === 'test' && !candidateIds.has(c.id);
    }
    summary.slices[task] = Object.fromEntries(Object.entries(slices).map(([name, filter]) => [name, { baseline: metrics(base.filter(r => r.task === task && filter(r)), task), jev: metrics(primary.filter(r => r.task === task && filter(r)), task) }]));
    summary.paired[task] = pairedInterval(test.map(r => ({ label: r.label, cluster: r.cluster, jev: r.prediction, baseline: base.find(b => b.id === r.id).prediction })));
    const repeats = fixture.cases.filter(c => c.task === task && c.split === 'test').map(c => main.filter(r => r.id === c.id));
    summary.consistency[task] = { totalCases: repeats.length, completeSuccessfulCases: repeats.filter(rs => rs.length === 3 && rs.every(r => r.prediction)).length, identicalSuccessfulCases: repeats.filter(rs => rs.length === 3 && rs.every(r => r.prediction) && new Set(rs.map(r => r.prediction)).size === 1).length };
    for (const r of test) {
      const b = base.find(b => b.id === r.id), c = fixture.cases.find(c => c.id === r.id);
      if (r.prediction !== b.prediction || r.prediction !== r.label) summary.disagreements.push({ id: r.id, task, origin: r.origin, label: r.label, baseline: b.prediction, jev: r.prediction, probability: r.probabilities?.[r.prediction] ?? null, rationale: c.rationale });
    }
    summary.cost[task] = { decisions: main.filter(r => r.task === task).length, billed: main.filter(r => r.task === task).reduce((s, r) => s + r.billedCost, 0), per1000: main.filter(r => r.task === task).length ? main.filter(r => r.task === task).reduce((s, r) => s + r.billedCost, 0) / main.filter(r => r.task === task).length * 1000 : null };
  }
  for (const concurrency of [1, 4]) {
    const rs = main.filter(r => r.concurrency === concurrency);
    const timings = lines('timings.jsonl').filter(t => t.phase === 'main' && t.concurrency === concurrency);
    const elapsed = timings.reduce((s, t) => s + t.elapsedMs, 0);
    summary.performance[concurrency] = { n: rs.length, medianMs: quantile(rs.map(r => r.latencyMs), 0.5), p95Ms: quantile(rs.map(r => r.latencyMs), 0.95), decisionsPerSecond: elapsed ? rs.length / (elapsed / 1000) : null, resumed: timings.some(t => t.resumed) };
  }
  summary.cost.totalBilled = attempts.reduce((s, a) => s + (a.billedCost ?? 0), 0);
  summary.cost.unknownBillingAttempts = attempts.filter(a => a.billedCost == null).length;
  summary.cost.budgetAccounted = attempts.reduce((s, a) => s + a.budgetCost, 0);
  summary.cost.inputTokens = attempts.reduce((s, a) => s + (a.response?.usage.input_tokens ?? 0), 0);
  summary.cost.outputTokens = attempts.reduce((s, a) => s + (a.response?.usage.output_tokens ?? 0), 0);
  summary.cost.totalAttempts = attempts.length;
  summary.cost.retryAttempts = attempts.filter(a => a.attempt > 0).length;
  summary.cost.failedAttempts = attempts.filter(a => a.error).length;
  summary.cost.per24FindingReport = {
    contradiction: summary.cost.contradiction.per1000 == null ? null : 24 * summary.cost.contradiction.per1000 / 1000,
    all276Pairs: summary.cost.dedup.per1000 == null ? null : 276 * summary.cost.dedup.per1000 / 1000,
    note: 'Projection from measured mean case sizes. All-pairs dedup grows quadratically. Not a measured whole-pipeline cost.',
  };
  summary.complete = main.length === fixture.cases.length * 3 && main.every(r => r.prediction);
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const md = [
    '# Jev versus current filters: controlled pilot', '',
    `Run: ${manifest.startedAt}. Model: ${[...new Set(predictions.map(r => r.model).filter(Boolean))].join(', ') || 'offline'}. Complete successful main run: ${summary.complete}.`, '',
    'Labels and prompts were frozen before inference. Accuracy is agreement with provisional assistant-curated semantic labels, not independently validated vulnerability accuracy. The test set contains 24 real cases/pairs and 66 constructed cases per task. Development contains 30 separate constructed cases per task. Main scores use the first repeat; repeats are not counted as extra independent examples.', '',
    '## Quality', '',
    '| Task / slice | N | Baseline accuracy | Jev accuracy | Baseline macro-F1 | Jev macro-F1 | Harmful errors baseline / Jev | Jev abstentions |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [task, slices] of Object.entries(summary.slices)) for (const [name, { baseline: b, jev: j }] of Object.entries(slices)) md.push(`| ${task} / ${name} | ${b.n} | ${pct(b.accuracy)} | ${pct(j.accuracy)} | ${num(b.macroF1)} | ${num(j.macroF1)} | ${b.harmfulErrors} / ${j.harmfulErrors} | ${j.abstentions} |`);
  md.push('', 'The baseline has two outputs and no abstention. Three-class accuracy therefore includes a capability difference. Clear-label accuracy below excludes gold unresolved/insufficient cases, still counting Jev abstentions and errors as incorrect. Harmful-error counts use known maintained/distinct cases; unsafe actions on uncertain cases are reported separately.', '', '| Task | Clear-label N | Baseline accuracy | Jev accuracy | Unsafe actions on uncertain baseline / Jev | Jev action coverage | Jev selective accuracy | Brier score |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [task, slices] of Object.entries(summary.slices)) { const { baseline: b, jev: j } = slices.test; md.push(`| ${task} | ${b.clearLabelN} | ${pct(b.clearLabelAccuracy)} | ${pct(j.clearLabelAccuracy)} | ${b.unsafeActionsOnUncertain} / ${j.unsafeActionsOnUncertain} | ${pct(j.actionCoverage)} | ${pct(j.selectiveAccuracy)} | ${num(j.brierScore)} |`); }
  md.push('', '## Cost and performance', '', `Billed total: **$${summary.cost.totalBilled.toFixed(6)}**, including smoke/group probes/retries. Budget accounting: $${summary.cost.budgetAccounted.toFixed(6)}. Unknown-billing attempts: ${summary.cost.unknownBillingAttempts}. Input/output tokens: ${summary.cost.inputTokens}/${summary.cost.outputTokens}. Attempts: ${attempts.length}; retries: ${summary.cost.retryAttempts}; failed attempts: ${summary.cost.failedAttempts}.`, '', '| Task | Measured API cost / 1,000 decisions |', '|---|---:|');
  for (const t of ['contradiction', 'dedup']) md.push(`| ${t} | $${summary.cost[t].per1000?.toFixed(6) ?? 'n/a'} |`);
  md.push('', '| Concurrency | Requests | Median latency ms | p95 latency ms | Decisions/sec |', '|---|---:|---:|---:|---:|');
  for (const [n, p] of Object.entries(summary.performance)) md.push(`| ${n} | ${p.n} | ${num(p.medianMs)} | ${num(p.p95Ms)} | ${num(p.decisionsPerSecond)} |`);
  md.push('', 'Baseline external API cost is $0. Local filter timings are in summary.json; sub-millisecond measurements include timer/runtime noise. Jev timings include network and retry waits. Throughput is not whole-pipeline speedup.', '', '## Repetition and uncertainty', '');
  for (const t of ['contradiction', 'dedup']) {
    const c = summary.consistency[t], p = summary.paired[t];
    md.push(`- ${t}: ${c.identicalSuccessfulCases}/${c.totalCases} held-out cases agreed across all three successful repeats. Paired accuracy difference: ${pct(p?.accuracyDifference)}; exploratory cluster-bootstrap 95% interval ${pct(p?.low)} to ${pct(p?.high)} (${p?.clusters ?? 0} source clusters).`);
  }
  md.push('', '**Only two source projects are available. These intervals cannot establish cross-project generalization.** Constructed variants share templates and source material; their count overstates independent evidence. Real reports are post-filter survivors, and the real duplicate pairs are all labeled distinct. This pilot cannot estimate natural duplicate recall.', '', 'Probability calibration, fixed-threshold risk/coverage curves, all confusion matrices, and grouping-order results are in summary.json. Thresholds are descriptive, not tuned on the held-out cases. Grouping uses conservative complete-link Jev pair decisions and is a simulation, not a production replacement.', '', '## Disagreements', '', '| Case | Origin | Expected | Baseline | Jev |', '|---|---|---|---|---|');
  for (const d of summary.disagreements) md.push(`| ${d.id} | ${d.origin} | ${d.label} | ${d.baseline} | ${d.jev ?? 'error'} |`);
  md.push('', '## Reproduce', '', '`npm run benchmark:jev -- --out benchmarks/jev/runs/new-run` with OPENROUTER_API_KEY configured. For local-only validation use `--offline`. Resume only into a matching run directory. Rebuild the report using `--report-only --out <existing-run>`. Fixtures, request hashes, prompts, source hashes, sanitized responses, and per-attempt billing provide the audit trail.', '', 'Production filters are unchanged. A deployment decision requires inspecting disagreements and independently adjudicating raw findings from additional projects.');
  writeFileSync(join(out, 'report.md'), md.join('\n') + '\n');
}
