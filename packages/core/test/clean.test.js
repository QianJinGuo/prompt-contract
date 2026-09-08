import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripWrappingQuotes, stripFences, stripReasoningBlocks, clampChars, postprocess } from '../src/clean.js';

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

test('stripReasoningBlocks removes closed think/reasoning blocks from reasoning models', () => {
  assert.equal(stripReasoningBlocks('<think>chain of thought</think>答案在这里'), '答案在这里');
  assert.equal(stripReasoningBlocks('<THINK>大写标签</THINK>\n结果'), '\n结果'); // trim 属于 postprocess
  assert.equal(stripReasoningBlocks('<thinking>…</thinking>输出'), '输出');
  assert.equal(stripReasoningBlocks('<reasoning>why</reasoning><thought>also why</thought>keep'), 'keep');
});

test('stripReasoningBlocks removes multiple blocks and keeps interleaved answer text', () => {
  const t = '<think>step 1</think>先做 A。<think>step 2</think>再做 B。';
  assert.equal(stripReasoningBlocks(t), '先做 A。再做 B。');
});

test('stripReasoningBlocks cuts an unclosed block to end-of-text (truncated stream)', () => {
  assert.equal(stripReasoningBlocks('<think>模型开始推理但流被截断'), '');
  assert.equal(stripReasoningBlocks('前置内容<think>未闭合'), '前置内容');
});

test('stripReasoningBlocks leaves plain text and non-reasoning tags untouched', () => {
  assert.equal(stripReasoningBlocks('正常回答，无任何标签'), '正常回答，无任何标签');
  assert.equal(stripReasoningBlocks('<answer>keep</answer>'), '<answer>keep</answer>');
});

test('postprocess: reasoning models produce clean output and pure-reasoning output maps to null', () => {
  const dirty = '<think>\n用户想要网站…\n```md\n草稿\n```\n</think>\n**结构化任务规范正文**';
  assert.equal(postprocess(dirty, 800), '**结构化任务规范正文**');
  assert.equal(postprocess('<think>只有推理</think>', 800), null);
});
