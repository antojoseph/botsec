import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewClaim, CLAIM_CHECKS } from '../dist/threat-model/claim-review.js';
import { dedupProvider } from '../dist/threat-model/providers/filters/dedup.js';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'claim-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'context'));
  writeFileSync(join(dir, 'src/C.sol'), 'contract C {\n  uint public balance;\n}\n');
  writeFileSync(join(dir, 'context/C.sol'), 'contract C {\n  uint private balance;\n}\n');
  const claim = { conclusion: 'supported', executionContext: 'An external user calls C', sourceReferences: [{ id: 'c1', path: 'src/C.sol', startLine: 2, endLine: 2, quote: '  uint public balance;' }], steps: [{ action: 'Read balance', expectedResult: 'Public getter returns stored balance', citationIds: ['c1'] }], checks: CLAIM_CHECKS.map(kind => ({ kind, result: ['callback-state', 'profit-and-loss'].includes(kind) ? 'not-applicable' : 'supported', reason: 'Fixture evidence, not an exploit verdict', citationIds: ['c1'] })), missingEvidence: [] };
  return { dir, claim };
}
test('matching source citations are hashed but never called an executed proof', t => {
  const { dir, claim } = fixture(t);
  const r = reviewClaim(dir, claim);
  assert.equal(r.status, 'citations-checked'); assert.equal(r.executionVerified, false);
  assert.match(r.sourceReferences[0].fileSha256, /^[a-f0-9]{64}$/);
  claim.sourceReferences[0].path = 'context/C.sol';
  assert.equal(reviewClaim(dir, claim).status, 'needs-review');
  claim.sourceReferences[0].quote = 'uint private balance;';
  assert.equal(reviewClaim(dir, claim).status, 'citations-checked');
  assert.notEqual(reviewClaim(dir, claim).sourceReferences[0].fileSha256, r.sourceReferences[0].fileSha256);
});
test('invented quotes, unavailable ranges, external paths and symlinks fail without losing findings', t => {
  const { dir, claim } = fixture(t);
  symlinkSync('/etc', join(dir, 'outside'));
  for (const change of [{ quote: 'require(false);' }, { startLine: 200, endLine: 200 }, { startLine: 1.5 }, { path: '/etc/passwd' }, { path: '../C.sol' }, { path: 'outside/passwd.sol' }, { path: 'absent.sol' }]) {
    const c = structuredClone(claim); Object.assign(c.sourceReferences[0], change);
    assert.equal(reviewClaim(dir, c).status, 'needs-review');
  }
  const c = structuredClone(claim); c.sourceReferences.push({ ...c.sourceReferences[0] });
  assert.match(reviewClaim(dir, c).issues.join(' '), /Duplicate/);
});
test('source quotes cannot override blocked guards or incomplete assessments', t => {
  const { dir, claim } = fixture(t);
  for (const mutate of [c => c.checks[1].result = 'blocked', c => c.missingEvidence.push('Unknown spender approval'), c => c.checks.pop(), c => c.steps[0].citationIds = ['invented'], c => c.checks[0].result = 'not-applicable', c => c.conclusion = 'unresolved']) {
    const c = structuredClone(claim); mutate(c);
    assert.equal(reviewClaim(dir, c).status, 'needs-review');
  }
  for (const input of [undefined, null, [], 'not an assessment']) assert.equal(reviewClaim(dir, input).status, 'not-assessed');
  for (const input of [{}, { sourceReferences: [null], steps: [null], checks: [null] }]) assert.equal(reviewClaim(dir, input).status, 'needs-review');
});
test('merging findings preserves original assessments and invalidates aggregate citation assurance', t => {
  const { dir, claim } = fixture(t);
  const threats = [1, 2, 3].map(i => ({ id: 't'+i, category: 'logic-error', severity: 'High', description: 'Claim '+i, affectedCode: ['C.balance'], suggestedProperties: [], claimAssessment: structuredClone(claim), claimReview: reviewClaim(dir, claim) }));
  const result = dedupProvider.apply(threats, {});
  assert.equal(result.length, 1); assert.equal(result[0].claimReview.status, 'needs-review');
  assert.equal(result[0].claimAssessment, undefined);
  assert.deepEqual(result[0].mergedClaims.map(c => c.findingId), ['t1', 't2', 't3']);
  assert.ok(result[0].mergedClaims.every(c => c.review.status === 'citations-checked'));
});
