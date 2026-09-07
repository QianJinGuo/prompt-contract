import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectScriptName } from '../src/lang.js';

test('dominant script detection', () => {
  assert.equal(detectScriptName('你好世界'), 'han');
  assert.equal(detectScriptName('hello world'), 'latin');
  assert.equal(detectScriptName('こんにちは世界'), 'japanese');
  assert.equal(detectScriptName('Привет мир'), 'cyrillic');
  assert.equal(detectScriptName('안녕하세요'), 'hangul');
});

test('mixed CJK/latin resolves to the CJK script', () => {
  assert.equal(detectScriptName('用 React 重构这个 module'), 'han');
  assert.equal(detectScriptName('refactor this module 用例'), 'han');
});

test('japanese beats han when kana present (enables zh→ja detection)', () => {
  assert.equal(detectScriptName('世界'), 'han');
  assert.equal(detectScriptName('世界です'), 'japanese');
});
