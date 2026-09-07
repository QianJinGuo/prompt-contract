import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enhance, assembleMessages, hardConstraints } from '../src/pipeline.js';
import { PromptBoostError } from '../src/errors.js';

const PROFILE = { name: 'coding-agent', maxChars: 800, body: 'You rewrite vague requests for a coding assistant.' };

function fakeProvider(reply, { fail } = {}) {
  const calls = [];
  return {
    calls,
    async complete(opts) {
      calls.push(opts);
      if (fail === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (fail === 'boom') throw new Error('socket hang up');
      return { text: reply };
    }
  };
}

test('assembleMessages embeds profile body, constraints, strength and context', () => {
  const { system, user } = assembleMessages('做个网站', { profile: PROFILE, strength: 'expand', context: 'repo: pet-project' });
  assert.match(system, /You rewrite vague requests/);
  assert.match(system, /HARD CONSTRAINTS:/);
  assert.match(system, /under 800 characters/);
  assert.match(system, /STRENGTH MODE: EXPAND/);
  assert.match(user, /USER INPUT:\n做个网站/);
  assert.match(user, /CONTEXT \(background[^\n]*\):\nrepo: pet-project/);
});

test('all three strengths render distinct modes', () => {
  for (const s of ['polish', 'standard', 'expand']) {
    const { system } = assembleMessages('x', { profile: PROFILE, strength: s });
    assert.match(system, new RegExp(`STRENGTH MODE: ${s.toUpperCase()}`));
  }
});

test('hardConstraints mirror the six eval rules', () => {
  const hc = hardConstraints({ maxChars: 800, strength: 'standard' });
  assert.match(hc, /same language as USER INPUT/);
  assert.match(hc, /no markdown fences/);
  assert.match(hc, /under 800 characters/);
  assert.match(hc, /EXPAND, DO NOT ANSWER/);
  assert.match(hc, /lightly polish/);
  assert.match(hc, /do not add requirements, features, or technologies/);
});

test('enhance: happy path returns cleaned text + original + meta', async () => {
  const provider = fakeProvider('  “请结构化地说明……”  ');
  const res = await enhance('帮我解释', { profile: PROFILE, provider, model: 'm1', strength: 'standard' });
  assert.equal(res.text, '请结构化地说明……');
  assert.equal(res.original, '帮我解释');
  assert.equal(res.meta.profile, 'coding-agent');
  assert.equal(res.meta.model, 'm1');
  assert.equal(typeof res.meta.ms, 'number');
  assert.equal(provider.calls[0].maxTokens, Math.ceil(800 * 1.2));
});

test('enhance: empty input → empty_input', async () => {
  await assert.rejects(
    () => enhance('   ', { profile: PROFILE, provider: fakeProvider('x') }),
    (e) => e instanceof PromptBoostError && e.code === 'empty_input'
  );
});

test('enhance: empty provider result → llm_error', async () => {
  await assert.rejects(
    () => enhance('hello', { profile: PROFILE, provider: fakeProvider('   ') }),
    (e) => e.code === 'llm_error'
  );
});

test('enhance: caller abort → aborted (ADR-017 semantics)', async () => {
  await assert.rejects(
    () => enhance('hello', { profile: PROFILE, provider: fakeProvider(null, { fail: 'abort' }) }),
    (e) => e.code === 'aborted'
  );
});

test('enhance: unexpected provider crash → provider_unavailable', async () => {
  await assert.rejects(
    () => enhance('hello', { profile: PROFILE, provider: fakeProvider(null, { fail: 'boom' }) }),
    (e) => e.code === 'provider_unavailable'
  );
});
