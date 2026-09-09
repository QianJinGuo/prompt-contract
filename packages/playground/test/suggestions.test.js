import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSuggestedPrompt, suggestionCount } from '../suggestions.js';

test('suggestions are profile-aware and cycle predictably', () => {
  assert.equal(suggestionCount('coding-agent'), 2);
  assert.match(getSuggestedPrompt('coding-agent'), /当前项目/);
  assert.notEqual(getSuggestedPrompt('coding-agent', 0), getSuggestedPrompt('coding-agent', 1));
  assert.match(getSuggestedPrompt('writing'), /中文邮件/);
  assert.match(getSuggestedPrompt('unknown'), /当前项目/);
});

test('negative indexes still resolve to a valid suggestion', () => {
  assert.equal(getSuggestedPrompt('writing', -1), getSuggestedPrompt('writing', 1));
});
