import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { hash, requestBody, QUESTIONS } from '../core.mjs';
const { values } = parseArgs({ options: { collection: { type: 'string' }, out: { type: 'string' } } });
if (!values.collection || !values.out) throw new Error('--collection and --out are required');
const collectionDir = resolve(values.collection), out = resolve(values.out);
const collection = JSON.parse(readFileSync(join(collectionDir, 'collection.json')));
if (!collection.finishedAt) throw new Error('Collection must be finished before freezing review cases');
if (existsSync(join(out, 'cases.json'))) throw new Error('Review dataset already exists');
mkdirSync(out, { recursive: true });
const cases = [], inputs = [];
for (const run of collection.runs) {
  if (run.status !== 'complete') continue;
  const filename = join(collectionDir, run.directory, 'raw-findings.json');
  const bytes = readFileSync(filename), raw = JSON.parse(bytes);
  inputs.push({ projectId: run.projectId, family: run.family, rawFile: run.directory + '/raw-findings.json', sha256: hash(bytes.toString('utf8')), count: raw.threats.length });
  const refs = raw.threats.map((_, i) => `${run.projectId}-f${String(i + 1).padStart(3, '0')}`);
  for (let i = 0; i < raw.threats.length; i++) {
    cases.push({ id: `${refs[i]}-position`, task: 'contradiction', project: run.family, findingRefs: [refs[i]], label: null, input: { finding: raw.threats[i] } });
    for (let j = i + 1; j < raw.threats.length; j++) cases.push({ id: `${refs[i]}-${refs[j]}-identity`, task: 'dedup', project: run.family, findingRefs: [refs[i], refs[j]], label: null, input: { findings: [raw.threats[i], raw.threats[j]] } });
  }
}
if (!cases.length) throw new Error('No completed findings are available for review');
if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Duplicate case IDs; preserve distinct run identities');
const dataset = { version: 1, split: 'development', labelingStatus: 'unlabeled; provisional assistant review or optional independent human review', candidatePolicy: 'Every raw finding and every unordered within-project pair from complete runs, before any synthesis filtering. No synthetic variants or prediction-selected cases.', inputs, cases };
writeFileSync(join(out, 'cases.json'), JSON.stringify(dataset, null, 2) + '\n');
const datasetSha256 = hash(JSON.stringify(dataset));
const packet = { version: 1, datasetSha256, rubric: QUESTIONS, cases: cases.map(c => ({ caseId: c.id, task: c.task, findingRefs: c.findingRefs, evidence: requestBody(c).state })) };
writeFileSync(join(out, 'blind-packet.json'), JSON.stringify(packet, null, 2) + '\n');
for (const reviewer of ['a', 'b']) writeFileSync(join(out, `reviewer-${reviewer}.json`), JSON.stringify({ version: 1, datasetSha256, reviewer: { id: null, kind: 'human' }, cases: cases.map(c => ({ caseId: c.id, label: null, rationale: '', sourceReferences: [], uncertainty: '' })) }, null, 2) + '\n');
writeFileSync(join(out, 'README.md'), `# Review packets\n\nHuman review is optional for this exploratory comparison. Provisional assistant labels must be identified as non-independent and frozen before Jev predictions. These blank files support a later independent review; they are not completed votes.\n\nDataset hash: \`${datasetSha256}\`.\n\nBoth reviewers receive only blind-packet.json and their own blank reviewer file. Keep cases.json, filter stages, baseline results, and Jev predictions outside the review packet. Each reviewer fills their identity, one rubric label per case, and a rationale. Preserve original votes before adjudicating disagreements. Unknown positions/identities must remain unresolved/insufficient; a trusted exploit reproduction does not label report identity or position. Do not treat another model's answer as independent ground truth.\n\nThis is a development collection of known public incidents. Every raw finding and every within-project pair is included, including findings later removed by anti-slop. Pairs are not independent observations; summarize uncertainty by project family. The sample does not estimate ordinary production false-positive rates.\n`);
console.log(JSON.stringify({ cases: cases.length, findings: cases.filter(c => c.task === 'contradiction').length, pairs: cases.filter(c => c.task === 'dedup').length, datasetSha256 }, null, 2));
