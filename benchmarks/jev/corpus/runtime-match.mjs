// Compare every runtime byte. The only permitted differences are the locations
// declared immutable by solc, and (reported separately) the 32-byte IPFS digest
// in a recognized Solidity metadata trailer. Never drop an arbitrary suffix.
export function compareRuntime(compiled, historical, immutableReferences = {}) {
  const clean = value => {
    const hex = value.replace(/^0x/, '').toLowerCase();
    if (!hex.length || hex.length % 2 || !/^[0-9a-f]+$/.test(hex)) throw new Error('Invalid runtime hex');
    return hex;
  };
  const original = clean(compiled), deployed = clean(historical);
  let a = original, b = deployed;
  const immutableValues = [];
  const occupied = new Set();
  for (const [astId, references] of Object.entries(immutableReferences)) {
    let firstValue;
    for (const { start, length } of references) {
      if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length !== 32 ||
          (start + length) * 2 > a.length || (start + length) * 2 > b.length) throw new Error('Invalid immutable range');
      for (let i = start; i < start + length; i++) {
        if (occupied.has(i)) throw new Error('Overlapping immutable ranges');
        occupied.add(i);
      }
      const value = deployed.slice(start * 2, (start + length) * 2);
      if (firstValue !== undefined && value !== firstValue) throw new Error('Inconsistent copies of immutable');
      firstValue = value;
      immutableValues.push({ astId, start, length, historicalValue: `0x${value}` });
      a = a.slice(0, start * 2) + '0'.repeat(length * 2) + a.slice((start + length) * 2);
      b = b.slice(0, start * 2) + '0'.repeat(length * 2) + b.slice((start + length) * 2);
    }
  }
  const trailer = /a2646970667358221220([0-9a-f]{64})64736f6c6343([0-9a-f]{6})0033$/;
  const ma = a.match(trailer), mb = b.match(trailer);
  const metadataDigestOnlyDifference = a !== b && a.length === b.length && ma && mb &&
    ma[2] === mb[2] && a.slice(0, -106) === b.slice(0, -106);
  return {
    exactMatch: original === deployed,
    matchExceptCompilerDeclaredImmutables: a === b,
    matchExceptImmutablesAndMetadataDigest: a === b || Boolean(metadataDigestOnlyDifference),
    metadataDigestOnlyDifference: Boolean(metadataDigestOnlyDifference),
    compiledRuntimeBytes: original.length / 2,
    historicalRuntimeBytes: deployed.length / 2,
    immutableValues,
  };
}
