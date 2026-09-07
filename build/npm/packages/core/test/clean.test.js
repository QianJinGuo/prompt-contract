import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripWrappingQuotes, stripFences, clampChars, postprocess } from '../src/clean.js';

test('stripWrappingQuotes removes paired quotes repeatedly', () => {
  assert.equal(stripWrappingQuotes('"hello"'), 'hello');
  assert.equal(stripWrappingQuotes('“你好世界”'), '你好世界');
  assert.equal(stripWrappingQuotes('‘“嵌套”’'), '嵌套');
  assert.equal(stripWrappingQuotes('「block」'), 'block');
});

test('stripWrappingQuotes keeps inner apostrophes', () => {
  assert.equal(stripWrappingQuotes("it's ok"), "it's ok");
});

test('stripFences removes full and partial fences', () => {
  assert.equal(stripFences('```\ntext\n```'), 'text');
  assert.equal(stripFences('```md\n# title\n```'), '# title');
  assert.equal(stripFences('```\nno closing'), 'no closing');
  assert.equal(stripFences('plain'), 'plain');
});

test('clampChars cuts at sentence boundary under the limit', () => {
  const t = '第一句。第二句。' + '长'.repeat(900);
  const out = clampChars(t, 800);
  assert.ok([...out].length <= 800);
  assert.ok(out.endsWith('。') || out.endsWith('长'));
});

test('clampChars removes dangling colon and list markers', () => {
  const t = '要点如下：' + 'x'.repeat(798);
  const out = clampChars(t, 800);
  assert.ok(!/[:：]\s*$/.test(out));
  assert.ok(!/[-*+]\s*$/.test(out));
});

test('clampChars leaves short text untouched', () => {
  assert.equal(clampChars('短文本', 800), '短文本');
});

test('postprocess: null for empty, strips combo of fences + quotes', () => {
  assert.equal(postprocess('   \n\t', 800), null);
  assert.equal(postprocess('```\n“最终文本”\n```', 800), '最终文本');
});
