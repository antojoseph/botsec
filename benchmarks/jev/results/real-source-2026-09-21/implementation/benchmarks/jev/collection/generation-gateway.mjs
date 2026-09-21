import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Budget } from '../core.mjs';

// A collection-only gateway: account for all generator and classifier calls,
// without exposing the real credential to the analysis subprocess. Preserve
// billing metadata, never authorization headers, prompts or server error text.
export async function generationGateway({ key, limitUsd, logPath }) {
  const budget = new Budget(limitUsd), token = randomBytes(24).toString('hex');
  let sequence = 0, pendingRequests = 0;
  const server = createServer(async (req, res) => {
    const fail = (status, message) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } })); };
    if (req.headers.authorization !== `Bearer ${token}`) return fail(401, 'Invalid collection gateway credential');
    if (req.method !== 'POST' || !/^\/v1\/messages(?:\?|$)/.test(req.url)) return fail(404, 'Unsupported collection endpoint');
    let chunks = [], size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 8_000_000) return fail(413, 'Collection request too large'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    let body; try { body = JSON.parse(bytes); } catch { return fail(400, 'Invalid request'); }
    if (!['anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5'].includes(body.model)) return fail(400, 'Unapproved generation model');
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 8192) return fail(400, 'Output limit must be between 1 and 8192');
    // Conservative reservation: one input token per request byte plus framing,
    // $10/M input (including cache writes), $30/M output. Both exceed these
    // models' published standard provider prices. Unknown bills retain it.
    const reservation = (bytes.length + 4096) * 10 / 1e6 + body.max_tokens * 30 / 1e6;
    let settle; try { settle = budget.reserve(reservation); } catch { return fail(402, 'Collection budget exhausted'); }
    pendingRequests++;
    const record = { request: ++sequence, model: body.model, requestBytes: bytes.length, maxOutputTokens: body.max_tokens, reservationUsd: reservation, startedAt: new Date().toISOString() };
    const start = performance.now();
    let responseId = null, usage = null, actual = null, partial = '';
    const observe = data => {
      if (data.message?.id) responseId = data.message.id;
      else if (data.id) responseId = data.id;
      if (data.message?.usage) usage = { ...usage, ...data.message.usage };
      if (data.usage) usage = { ...usage, ...data.usage };
    };
    try {
      const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
      if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
      const upstream = await fetch('https://openrouter.ai/api/v1/messages', { method: 'POST', headers, body: bytes, signal: AbortSignal.timeout(180_000) });
      record.status = upstream.status;
      if (!upstream.ok) { fail(upstream.status, `Generation provider HTTP ${upstream.status}`); }
      else if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const decoder = new TextDecoder();
        for await (const chunk of upstream.body) {
          res.write(chunk); partial += decoder.decode(chunk, { stream: true });
          let newline;
          while ((newline = partial.indexOf('\n')) >= 0) {
            const line = partial.slice(0, newline).trim(); partial = partial.slice(newline + 1);
            if (line.startsWith('data:')) try { observe(JSON.parse(line.slice(5).trim())); } catch { /* keep-alive or completion */ }
          }
        }
        res.end();
      } else {
        const text = await upstream.text(); observe(JSON.parse(text)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(text);
      }
      if (upstream.ok && responseId) {
        for (const delay of [200, 1000, 2500]) {
          await new Promise(resolve => setTimeout(resolve, delay));
          const result = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(responseId)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
          if (!result.ok) continue;
          const detail = (await result.json()).data;
          if (typeof detail?.total_cost === 'number' && Number.isFinite(detail.total_cost) && detail.total_cost >= 0) {
            actual = detail.total_cost;
            record.provider = detail.provider_name ?? null;
            record.billedModel = detail.model ?? null;
            break;
          }
        }
      }
    } catch (error) { record.error = error.name === 'TimeoutError' ? 'timeout' : 'transport-or-parse-failure'; if (!res.writableEnded) fail(502, 'Generation transport failed'); }
    finally {
      settle(actual); record.responseId = responseId; record.usage = usage; record.billedCostUsd = actual;
      record.budgetChargeUsd = actual ?? reservation; record.durationMs = performance.now() - start;
      appendFileSync(logPath, JSON.stringify(record) + '\n');
      pendingRequests--;
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, token, budget,
    close: async () => { await new Promise(resolve => server.close(resolve)); while (pendingRequests) await new Promise(resolve => setTimeout(resolve, 50)); } };
}
