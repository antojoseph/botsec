import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
const { values } = parseArgs({ options: { collection: { type: 'string' }, out: { type: 'string' } } });
if (!values.collection || !values.out) throw new Error('--collection and --out are required');
const directory = resolve(values.collection), read = name => JSON.parse(readFileSync(join(directory, name)));
const manifest = read('collection.json');
if (!manifest.finishedAt) throw new Error('Collection is not finished');
const ledger = readFileSync(join(directory, 'generation-billing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const counts = values => values.reduce((out, value) => (out[value] = (out[value] || 0) + 1, out), {});
const runs = manifest.runs.map(run => {
  if (run.status !== 'complete') return { ...run, evidenceAssessment: 'Generation did not complete; no security verdict inferred' };
  const raw = read(run.directory + '/raw-findings.json');
  const reviews = read(run.directory + '/claim-reviews.json');
  const final = read(run.directory + '/threat-model.json');
  const generation = read(run.directory + '/generation-result.json');
  if (reviews.length !== raw.threats.length || reviews.some((r, i) => r.id !== raw.threats[i].id)) throw new Error('Claim review alignment mismatch');
  const citations = reviews.flatMap(r => r.review.sourceReferences);
  return { ...run, rawFindingCount: raw.threats.length, finalFindingCount: final.threats.length,
    dismissedCandidateCount: raw.dismissedCandidates?.length ?? 0,
    generatorConclusions: counts(raw.threats.map(t => t.claimAssessment?.conclusion ?? 'not-assessed')),
    mechanicalReviewStatus: counts(reviews.map(r => r.review.status)),
    citations: { total: citations.length, quoteMatches: citations.filter(c => c.quoteMatches).length, failed: citations.filter(c => !c.quoteMatches).length },
    findingReviews: raw.threats.map((t, i) => ({ id: t.id, ordinal: i + 1, title: t.title, claimedConclusion: t.claimAssessment?.conclusion ?? null, review: reviews[i].review })),
    sdkDurationMs: generation.durationMs, sdkReportedCostUsd: generation.sdkReportedCostUsd, completionStatus: generation.completionStatus };
});
const result = { version: 1, collectionSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), completedAt: manifest.finishedAt,
  interpretation: 'Mechanical source-quote checks and generator judgments, not vulnerability accuracy. Reference-mechanism assessment is retained separately. No exploit execution is claimed.',
  generationRequests: ledger.length, billedCostUsd: ledger.reduce((s, r) => s + (r.billedCostUsd ?? 0), 0), unknownBills: ledger.filter(r => r.billedCostUsd == null).length,
  budgetChargedUsd: ledger.reduce((s, r) => s + r.budgetChargeUsd, 0), runs };
writeFileSync(resolve(values.out), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ billedCostUsd: result.billedCostUsd, unknownBills: result.unknownBills, runs: runs.map(r => ({ family: r.family, status: r.status, raw: r.rawFindingCount, final: r.finalFindingCount, dismissed: r.dismissedCandidateCount, citations: r.citations, review: r.mechanicalReviewStatus })) }, null, 2));
