import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractExplorerSources } from '../benchmarks/jev/corpus/explorer-source.mjs';

function page(data) {
  const literal = JSON.stringify(JSON.stringify(data)).slice(1, -1).replaceAll("'", '\\u0027');
  return `irrelevant HTML; var editor_contractJsonData = '${literal}'; throw new Error('must never run');`;
}
test('explorer source is decoded as data including nested escapes, not evaluated', () => {
  const source = { language: 'Solidity', sources: { 'src/Target.sol': { content: '// owner\'s source\nstring constant x = "quoted";' } } };
  assert.deepEqual(extractExplorerSources(page(source)), source);
});
test('explorer extraction rejects missing source, malformed strings, and traversal paths', () => {
  assert.throws(() => extractExplorerSources('<html>challenge</html>'), /not found/);
  assert.throws(() => extractExplorerSources("var editor_contractJsonData = 'unfinished"), /Unterminated/);
  assert.throws(() => extractExplorerSources(page({ language: 'Solidity', sources: { '../escape.sol': { content: 'x' } } })), /Invalid source/);
  assert.throws(() => extractExplorerSources(page({ language: 'Solidity', sources: {} })), /Missing/);
});
