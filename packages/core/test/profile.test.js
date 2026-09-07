import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, parseYamlLite } from '../src/profile.js';
import { PromptBoostError } from '../src/errors.js';

const SAMPLE = `---
name: test-profile
domain: 测试场景
maxChars: 600
noUnmentionedTech: true
---
You rewrite vague requests. Preserve intent and language.`;

test('parseProfile reads frontmatter scalars and body', () => {
  const p = parseProfile(SAMPLE, { path: 'test.md' });
  assert.equal(p.name, 'test-profile');
  assert.equal(p.domain, '测试场景');
  assert.equal(p.maxChars, 600);
  assert.equal(p.noUnmentionedTech, true);
  assert.match(p.body, /Preserve intent and language\.$/);
});

test('parseProfile applies defaults', () => {
  const p = parseProfile('---\nname: minimal\n---\nBody here.');
  assert.equal(p.maxChars, 800);
  assert.equal(p.noUnmentionedTech, true);
  assert.equal(p.domain, '');
});

test('parseProfile rejects malformed input with config_error', () => {
  assert.throws(() => parseProfile('no frontmatter here'), (e) => e instanceof PromptBoostError && e.code === 'config_error');
  assert.throws(() => parseProfile('---\ndomain: x\n---\nbody'), (e) => e.code === 'config_error');
});

test('parseYamlLite handles string lists', () => {
  const y = parseYamlLite('items:\n  - a\n  - b\nflag: false\ncount: 3');
  assert.deepEqual(y.items, ['a', 'b']);
  assert.equal(y.flag, false);
  assert.equal(y.count, 3);
});
