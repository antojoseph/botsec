import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { reviewSourceCitations } from '../../dist/threat-model/claim-review.js';
const { values } = parseArgs({ options: { collection: { type: 'string' }, preparation: { type: 'string' }, out: { type: 'string' } } });
if (!values.collection || !values.out) throw new Error('--collection and --out are required');
const root = resolve(values.collection);
const manifest = JSON.parse(readFileSync(join(root, 'collection.json')));
if (!manifest.finishedAt) throw new Error('Collection must be finished');
const preparation = values.preparation ? JSON.parse(readFileSync(resolve(values.preparation))) : manifest.preparation;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const projects = [];
for (const run of manifest.runs.filter(r => r.status === 'complete')) {
  const original = manifest.preparation.projects.find(p => p.id === run.projectId);
  const restored = preparation.projects.find(p => p.id === run.projectId);
  if (!original || !restored) throw new Error('Missing project preparation');
  for (const f of original.inventory) if (hash(readFileSync(join(restored.directory, f.path))) !== f.sha256) throw new Error('Source differs from generation snapshot');
  const path = join(root, run.directory, 'raw-findings.json'), bytes = readFileSync(path), raw = JSON.parse(bytes);
  const candidates = (raw.dismissedCandidates || []).map((c, i) => ({ ordinal: i + 1, title: c.title, review: reviewSourceCitations(restored.directory, c.sourceReferences) }));
  projects.push({ family: run.family, projectId: run.projectId, rawSha256: hash(bytes), candidates });
}
const output = { version: 1, collectionSha256: hash(JSON.stringify(manifest)), checkerSha256: hash(readFileSync(new URL('../../dist/threat-model/claim-review.js', import.meta.url))),
  interpretation: 'Post-generation mechanical checks of dismissal citations; retained separately from original evidence. Exact quote matching does not establish that a rejection is correct.', projects };
writeFileSync(resolve(values.out), JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(projects.map(p => ({ family: p.family, candidates: p.candidates.length, citationsChecked: p.candidates.filter(c => c.review.status === 'citations-checked').length })), null, 2));
