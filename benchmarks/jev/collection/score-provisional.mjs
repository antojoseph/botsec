import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { hash, LABELS, metrics, pairedInterval } from '../core.mjs';
const { values } = parseArgs({ options: { cases: { type: 'string' }, labels: { type: 'string' }, shadow: { type: 'string' }, out: { type: 'string' } } });
if (!values.cases || !values.labels || !values.shadow || !values.out) throw new Error('--cases, --labels, --shadow and --out are required');
const read = p => JSON.parse(readFileSync(resolve(p)));
const dataset = read(values.cases), labels = read(values.labels), manifest = read(join(values.shadow, 'manifest.json'));
if (labels.reviewer?.kind !== 'assistant' || labels.reviewer?.independent !== false) throw new Error('This scorer requires explicitly provisional assistant labels');
if (hash(JSON.stringify(dataset)) !== labels.datasetSha256 || labels.datasetSha256 !== manifest.datasetSha256) throw new Error('Dataset hash mismatch');
if (hash(JSON.stringify(labels)) !== manifest.provisionalLabelsSha256) throw new Error('Labels differ from the pre-comparison snapshot');
if (!(Date.parse(labels.createdAt) <= Date.parse(manifest.startedAt))) throw new Error('Labels must predate comparison');
const predictions = readFileSync(resolve(values.shadow, 'predictions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const [name, rows, key] of [['labels', labels.cases, 'caseId'], ['predictions', predictions, 'id'], ['dataset', dataset.cases, 'id']]) {
  if (rows.length !== dataset.cases.length || new Set(rows.map(r => r[key])).size !== rows.length) throw new Error(`Incomplete or duplicate ${name}`);
}
const rows = dataset.cases.map(c => {
  const label = labels.cases.find(r => r.caseId === c.id), p = predictions.find(r => r.id === c.id);
  if (!label || !p || p.task !== c.task || p.project !== c.project || !LABELS[c.task].includes(label.label) || !label.rationale?.trim()) throw new Error('Case mismatch or invalid label');
  if (![p.baseline?.prediction, p.jev?.prediction].every(x => x == null || LABELS[c.task].includes(x))) throw new Error('Invalid prediction');
  if ((label.alternativeLabels || []).some(x => !LABELS[c.task].includes(x))) throw new Error('Invalid alternative label');
  return { ...c, label: label.label, alternativeLabels: label.alternativeLabels || [], baseline: p.baseline, jev: p.jev };
});
const taskScore = rs => {
  const summary = {};
  for (const task of ['contradiction', 'dedup']) {
    const ts = rs.filter(r => r.task === task);
    const score = engine => metrics(ts.map(r => ({ label: r.label, prediction: r[engine]?.prediction, probabilities: r[engine]?.probabilities, latencyMs: r[engine]?.latencyMs ?? 0 })), task);
    // Exact sensitivity bounds: allow only the alternatives frozen before comparison.
    const deltaOptions = ts.map(r => [r.label, ...r.alternativeLabels].map(l => Number(r.jev?.prediction === l) - Number(r.baseline?.prediction === l)));
    summary[task] = { baseline: score('baseline'), jev: score('jev'), pairedExploratoryInterval: pairedInterval(ts.map(r => ({ label: r.label, baseline: r.baseline?.prediction, jev: r.jev?.prediction, cluster: r.project }))),
      labelSensitivity: { ambiguousCases: ts.filter(r => r.alternativeLabels.length).map(r => r.id), minimumAgreementDifference: ts.length ? deltaOptions.reduce((s, d) => s + Math.min(...d), 0) / ts.length : null, maximumAgreementDifference: ts.length ? deltaOptions.reduce((s, d) => s + Math.max(...d), 0) / ts.length : null } };
  }
  return summary;
};
const summary = { version: 1, createdAt: new Date().toISOString(), datasetSha256: labels.datasetSha256, labelsSha256: hash(JSON.stringify(labels)), comparisonManifestSha256: hash(JSON.stringify(manifest)), independentAccuracy: null,
  interpretation: 'All accuracy fields below mean agreement with provisional, non-independent assistant labels. They do not estimate vulnerability-detection accuracy or production accuracy. Absent-class recall/F1 is not estimable; consult support counts. Pairs share reports and projects.',
  tasks: taskScore(rows), byProject: Object.fromEntries([...new Set(rows.map(r => r.project))].map(p => [p, taskScore(rows.filter(r => r.project === p))])) };
writeFileSync(resolve(values.out), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(Object.fromEntries(Object.entries(summary.tasks).map(([task, s]) => [task, { n: s.baseline.n, baselineAgreement: s.baseline.accuracy, jevAgreement: s.jev.accuracy, labelSensitivity: s.labelSensitivity }])), null, 2));
