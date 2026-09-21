import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRuntime } from '../benchmarks/jev/corpus/runtime-match.mjs';

const footer = digest => `a2646970667358221220${digest.repeat(32)}64736f6c63430008110033`;
test('runtime matching tolerates only the recognized metadata digest', () => {
  const a = `60006001${footer('aa')}`, b = `60006001${footer('bb')}`;
  assert.equal(compareRuntime(a, b).metadataDigestOnlyDifference, true);
  assert.equal(compareRuntime(a, `60016001${footer('bb')}`).matchExceptImmutablesAndMetadataDigest, false);
  assert.equal(compareRuntime(a, b.slice(0, -4) + '0032').matchExceptImmutablesAndMetadataDigest, false);
  assert.equal(compareRuntime(a, b.replace('000811', '000810')).matchExceptImmutablesAndMetadataDigest, false);
});
test('immutable masking validates bounds and all deployed copies', () => {
  const a = '60' + '00'.repeat(64), b = '60' + 'ab'.repeat(64);
  const refs = { 1: [{ start: 1, length: 32 }, { start: 33, length: 32 }] };
  assert.equal(compareRuntime(a, b, refs).matchExceptCompilerDeclaredImmutables, true);
  assert.equal(compareRuntime(a, '61' + b.slice(2), refs).matchExceptCompilerDeclaredImmutables, false);
  assert.throws(() => compareRuntime(a, b.slice(0, -2) + 'aa', refs), /Inconsistent/);
  assert.throws(() => compareRuntime(a, b, { 1: [{ start: 34, length: 32 }] }), /Invalid immutable/);
  assert.throws(() => compareRuntime(a, b, { 1: [{ start: 1, length: 32 }, { start: 1, length: 32 }] }), /Overlapping/);
});
