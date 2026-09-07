import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer, EN_RESULT, ZH_RESULT } from '../../../mock/server.js';
import { createOpenAIProvider } from '../src/openai.js';
import { createOllamaProvider } from '../src/ollama.js';
import { PromptContractError } from '../../core/src/errors.js';

let mock, base;
before(async () => {
  mock = createMockServer({});
  const port = await mock.listen();
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await mock.close(); });

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
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(mock.state.aborts >= 1, 'mock should have observed the aborted connection');
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
