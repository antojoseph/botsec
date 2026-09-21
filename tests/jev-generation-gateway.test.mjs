import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generationGateway } from '../benchmarks/jev/collection/generation-gateway.mjs';
test('generation gateway settles billed usage and rejects unapproved requests before spending', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-gateway-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const localFetch = globalThis.fetch;
  let upstreamCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    upstreamCalls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/messages');
    assert.equal(options.headers.Authorization, 'Bearer secret-test-value');
    return new Response(JSON.stringify({ id: 'generation-test', usage: { cost: 0.001, input_tokens: 10, output_tokens: 1 } }));
  });
  const logPath = join(dir, 'billing.jsonl');
  const gateway = await generationGateway({ key: 'secret-test-value', limitUsd: 1, logPath });
  const request = (model, token = gateway.token) => localFetch(gateway.url + '/v1/messages', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ model, max_tokens: 100 }) });
  try {
    assert.equal((await request('anthropic/claude-sonnet-4.6', 'wrong')).status, 401);
    assert.equal((await request('other-model')).status, 400);
    assert.equal((await request('anthropic/claude-sonnet-4.6')).status, 200);
  } finally { await gateway.close(); }
  assert.equal(upstreamCalls, 1);
  assert.equal(gateway.budget.spent, 0.001);
  assert.equal(gateway.budget.pending, 0);
  const text = readFileSync(logPath, 'utf8');
  assert.equal(JSON.parse(text).billedCostUsd, 0.001);
  assert.ok(!text.includes('secret-test-value'));
});
