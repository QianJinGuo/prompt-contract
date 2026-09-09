import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer, EN_RESULT, ZH_RESULT } from '../../../mock/server.js';
import { createOpenAIProvider } from '../src/openai.js';
import { createAnthropicProvider } from '../src/anthropic.js';
import { createOllamaProvider } from '../src/ollama.js';
import { PromptContractError } from '../../core/src/errors.js';

let mock, base;
before(async () => {
  mock = createMockServer({});
  const port = await mock.listen();
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await mock.close(); });

/** Poll until a predicate holds (mock streams are throttled; fixed sleeps are flaky). */
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return predicate();
}

test('openai provider reassembles SSE chunks in order', async () => {
  const p = createOpenAIProvider({ baseUrl: `${base}/v1`, apiKey: 'test-key-123' });
  let deltas = 0;
  const { text } = await p.complete({ system: 's', user: 'USER INPUT:\n帮我做一个展示我家狗的网站', model: 'mock-model', onDelta: () => deltas++ });
  assert.equal(text, ZH_RESULT);
  assert.ok(deltas > 3, `expected multiple deltas, got ${deltas}`);
});

test('openai provider handles english input', async () => {
  const p = createOpenAIProvider({ baseUrl: `${base}/v1`, apiKey: 'test-key-123' });
  const { text } = await p.complete({ system: 's', user: 'USER INPUT:\nA website for my dog', model: 'mock-model' });
  assert.equal(text, EN_RESULT);
});

test('openai provider maps non-200 to provider_unavailable', async () => {
  const p = createOpenAIProvider({ baseUrl: base, apiKey: 'test-key-123' }); // /chat/completions → 404
  await assert.rejects(
    () => p.complete({ system: 's', user: 'u', model: 'm' }),
    (e) => e instanceof PromptContractError && e.code === 'provider_unavailable'
  );
});

test('openai provider: caller abort cancels the stream (ADR-017)', async () => {
  const p = createOpenAIProvider({ baseUrl: `${base}/v1`, apiKey: 'test-key-123' });
  const ctrl = new AbortController();
  const promise = p.complete({
    system: 's', user: 'USER INPUT:\nA website for my dog', model: 'm',
    signal: ctrl.signal,
    onDelta: () => ctrl.abort()
  });
  await assert.rejects(promise, (e) => e.name === 'AbortError');
  assert.equal(await waitFor(() => mock.state.aborts >= 1), true, 'mock should have observed the aborted connection');
});

test('ollama provider sends keep_alive so the model stays warm (R10)', async () => {
  const p = createOllamaProvider({ baseUrl: base, keepAlive: '60m' });
  const { text } = await p.complete({ system: 's', user: 'USER INPUT:\n帮我做一个展示我家狗的网站', model: 'mock-model', maxTokens: 960 });
  assert.equal(text, ZH_RESULT);
  assert.equal(mock.state.lastChatBody.keep_alive, '60m');
  assert.equal(mock.state.lastChatBody.options.num_predict, 960);
});

test('ollama warmup preloads the model via /api/generate (R10)', async () => {
  const p = createOllamaProvider({ baseUrl: base, keepAlive: '30m' });
  await p.warmup({ model: 'mock-model' });
  assert.equal(mock.state.lastGenerateBody.model, 'mock-model');
  assert.equal(mock.state.lastGenerateBody.keep_alive, '30m');
});

test('anthropic provider reassembles text_delta chunks, drops thinking deltas, and sends max_tokens', async () => {
  const p = createAnthropicProvider({ baseUrl: base, apiKey: 'test-key-123' });
  const deltas = [];
  const { text } = await p.complete({
    system: 'sys', user: 'USER INPUT:\n帮我做一个展示我家狗的网站', model: 'mock-model',
    maxTokens: 960, onDelta: (d) => deltas.push(d)
  });
  assert.equal(text, ZH_RESULT);
  assert.ok(deltas.length > 3, `expected multiple deltas, got ${deltas.length}`);
  assert.ok(deltas.every((d) => !d.includes('internal reasoning')), 'thinking deltas must never surface');
  assert.equal(mock.state.lastMessagesBody.system, 'sys');
  assert.equal(mock.state.lastMessagesBody.max_tokens, 960, 'anthropic requires max_tokens');
  assert.equal(mock.state.lastMessagesBody.messages.length, 1);
  assert.equal(mock.state.lastMessagesBody.messages[0].role, 'user');
});

test('anthropic provider: caller abort cancels the stream (ADR-017)', async () => {
  const p = createAnthropicProvider({ baseUrl: base, apiKey: 'test-key-123' });
  const ctrl = new AbortController();
  const promise = p.complete({
    system: 's', user: 'USER INPUT:\nA website for my dog', model: 'm',
    signal: ctrl.signal,
    onDelta: () => ctrl.abort()
  });
  await assert.rejects(promise, (e) => e.name === 'AbortError');
  assert.equal(await waitFor(() => mock.state.aborts >= 1), true, 'mock should have observed the aborted connection');
});

test('anthropic provider maps non-200 to provider_unavailable', async () => {
  const p = createAnthropicProvider({ baseUrl: base, apiKey: 'wrong-key' });
  await assert.rejects(
    () => p.complete({ system: 's', user: 'u', model: 'm' }),
    (e) => e instanceof PromptContractError && e.code === 'provider_unavailable'
  );
});

test('anthropic warmup is a best-effort GET that never throws', async () => {
  const p = createAnthropicProvider({ baseUrl: base, apiKey: 'test-key-123' });
  await p.warmup({ signal: undefined }); // /v1/models on the mock returns 200
  const offline = createAnthropicProvider({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
  await offline.warmup(); // unreachable → swallowed
});
