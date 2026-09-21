import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { hash, LABELS } from '../core.mjs';
const { values } = parseArgs({ options: { cases: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' }, out: { type: 'string' } } });
if (!values.cases || !values.a || !values.b || !values.out) throw new Error('--cases, --a, --b and --out are required');
const read = p => JSON.parse(readFileSync(p));
const dataset = read(values.cases), expectedHash = hash(JSON.stringify(dataset)), a = read(values.a), b = read(values.b);
const ids = new Map(dataset.cases.map(c => [c.id, c.task]));
for (const review of [a, b]) {
  if (review.datasetSha256 !== expectedHash || review.reviewer?.kind !== 'human' || !review.reviewer?.id?.trim()) throw new Error('A named independent human reviewer and matching dataset hash are required');
  if (review.cases.length !== ids.size || new Set(review.cases.map(c => c.caseId)).size !== ids.size) throw new Error('Missing or duplicate review cases');
  for (const c of review.cases) if (!LABELS[ids.get(c.caseId)]?.includes(c.label) || !c.rationale?.trim()) throw new Error('Every case needs a valid label and rationale');
}
if (a.reviewer.id.trim().toLowerCase() === b.reviewer.id.trim().toLowerCase()) throw new Error('Reviewers must be different people');
if (existsSync(values.out)) throw new Error('Refusing to overwrite adjudication evidence');
const am = new Map(a.cases.map(c => [c.caseId, c])), bm = new Map(b.cases.map(c => [c.caseId, c]));
const cases = dataset.cases.map(c => ({ ...c, votes: [am.get(c.id), bm.get(c.id)], label: am.get(c.id).label === bm.get(c.id).label ? am.get(c.id).label : null, adjudicationStatus: am.get(c.id).label === bm.get(c.id).label ? 'reviewers-agree' : 'needs-third-review' }));
writeFileSync(values.out, JSON.stringify({ ...dataset, parentDatasetSha256: expectedHash, labelingStatus: cases.some(c => c.label === null) ? 'disputes-pending' : 'two-reviewers-agree', reviewers: [a.reviewer, b.reviewer], cases }, null, 2) + '\n', { flag: 'wx' });
console.log(`${cases.filter(c => c.label !== null).length} agreements; ${cases.filter(c => c.label === null).length} disputes preserved.`);
