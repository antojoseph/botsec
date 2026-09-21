import { performance } from 'node:perf_hooks';
import { ENDPOINT, INPUT_PRICE, parseResponse } from './core.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function decide(body, task, { key, budget, fetchFn = fetch, sleep = wait, timeoutMs = 30_000, maxRetries = 2, onAttempt = () => {} } = {}) {
  const attempts = []; const started = performance.now();
  // Reserve the price of the endpoint's full 32K input window per attempt.
  // Unknown billing on errors/timeouts consumes that reservation permanently.
  const reserveCost = 32_000 * INPUT_PRICE;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const settle = budget.reserve(reserveCost);
    const start = performance.now();
    let response, raw, parsed, error, fatal = false, retry = false;
    try {
      response = await fetchFn(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      fatal = [400, 401, 402, 403, 404, 413].includes(response.status);
      retry = [429, 500, 502, 503, 504, 524, 529].includes(response.status);
      raw = await response.json();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      parsed = parseResponse(raw, task);
    } catch (e) {
      // Never save arbitrary server error text, request headers, or credentials.
      error = e.name === 'TimeoutError' ? 'Request timeout' : response ? (response.ok ? 'Invalid Decisions response' : `HTTP ${response.status}`) : 'Network failure';
      retry ||= !response || e.name === 'TimeoutError';
      lastError = error;
    }
    const cost = raw?.usage?.cost;
    const billedCost = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
    const estimatedCost = parsed ? parsed.usage.input_tokens * INPUT_PRICE : reserveCost;
    settle(billedCost ?? estimatedCost);
    const record = { attempt, status: response?.status ?? null, latencyMs: performance.now() - start, billedCost, budgetCost: billedCost ?? estimatedCost, error, ...(parsed ? { response: parsed } : {}) };
    attempts.push(record); onAttempt(record);
    if (parsed) return { ...parsed, latencyMs: performance.now() - started, attempts };
    if (fatal) { const e = new Error(lastError); e.fatal = true; e.attempts = attempts; throw e; }
    if (!retry || attempt === maxRetries) break;
    const retryHeader = response?.headers?.get('retry-after');
    const seconds = retryHeader && Number(retryHeader);
    const delay = retryHeader ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryHeader) - Date.now()) : 250 * 2 ** attempt;
    // A long Retry-After is honored by ending this request, rather than retrying early.
    if (delay > 30_000) break;
    await sleep(Number.isFinite(delay) ? Math.max(0, delay) : 250 * 2 ** attempt);
  }
  return { prediction: null, probabilities: null, confidence: null, error: lastError, latencyMs: performance.now() - started, attempts };
}
