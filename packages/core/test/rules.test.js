import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRules } from '../src/rules.js';

const GOOD_EN = 'Build a small responsive website showcasing one pet: a photo gallery, a biography page, and an update feed. Keep navigation simple and skip comments.';
const GOOD_ZH = '做一个展示宠物的小型网站：包含照片画廊、简介页与动态页，导航保持单层，暂不需要评论功能。';

test('good outputs pass all six assertions', () => {
  for (const [orig, out] of [['A website for my dog', GOOD_EN], ['帮我做一个宠物网站', GOOD_ZH]]) {
    const { pass, results } = checkRules(orig, out);
    assert.equal(pass, true, JSON.stringify(results.filter((r) => !r.pass)));
  }
});

test('lang-consistency fails on script switch', () => {
  const { results } = checkRules('帮我做一个网站', GOOD_EN);
  const r = results.find((r) => r.id === 'lang-consistency');
  assert.equal(r.pass, false);
});

test('only-enhanced-text fails on fences, wrapping quotes and meta labels', () => {
  for (const bad of ['```text\nx\n```', '“结果”', '增强后的提示词：写一封邮件', 'Enhanced prompt: do something']) {
    const { results } = checkRules('写一封邮件', bad, { maxChars: 800 });
    assert.equal(results.find((r) => r.id === 'only-enhanced-text').pass, false, bad);
  }
});

test('length-limit fails on overflow and dangling colon', () => {
  const long = 'x'.repeat(900);
  const { results } = checkRules('x', long);
  assert.equal(results.find((r) => r.id === 'length-limit').pass, false);
  const { results: r2 } = checkRules('x', '要点如下：');
  assert.equal(r2.find((r) => r.id === 'length-limit').pass, false);
});

test('expand-not-answer fails on answer openers and clarifying questions', () => {
  for (const bad of ['好的，以下是实现方案：先装依赖再写组件。', "Here's how you can do it: install the deps first.", '你想用哪种框架？']) {
    const { results } = checkRules('做个网站', bad);
    assert.equal(results.find((r) => r.id === 'expand-not-answer').pass, false, bad);
  }
});

test('no-hallucinated-tech flags tech names absent from input', () => {
  const { results } = checkRules('做一个读书笔记应用', '用 React 和 PostgreSQL 构建笔记应用');
  assert.equal(results.find((r) => r.id === 'no-hallucinated-tech').pass, false);
  const ok = checkRules('用 React 做个笔记应用', '用 React 实现笔记的增删改查，数据存本地文件，支持全文检索');
  assert.equal(ok.results.find((r) => r.id === 'no-hallucinated-tech').pass, true);
});

test('japanese output fails for chinese input (kana detector)', () => {
  const { results } = checkRules('サイトを作って', '做一个展示宠物的网站：包含照片画廊。');
  assert.equal(results.find((r) => r.id === 'lang-consistency').pass, false);
});
