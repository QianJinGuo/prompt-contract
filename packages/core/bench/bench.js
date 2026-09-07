/**
 * Engine overhead benchmark — the part of the latency budget we own (PRD §5.3/§7.6).
 * The model TTFT is external and dominates end-to-end latency; this proves the engine adds
 * effectively nothing on top (budget: P50 < 5ms, in practice microseconds).
 */
import { assembleMessages } from '../src/pipeline.js';
import { postprocess } from '../src/clean.js';
import { checkRules } from '../src/rules.js';

const PROFILE = { name: 'coding-agent', maxChars: 800, body: 'You rewrite vague requests for a coding assistant. '.repeat(4) };
const INPUTS = [
  '帮我做一个展示我家狗的网站',
  'A website for my dog',
  'explain this code',
  '把这份周报改正式一点',
  '一只在雪地里的柴犬'
];
const OUTPUT = '做一个展示宠物的小型网站：包含照片画廊、简介页与动态页，导航保持单层，暂不需要评论功能。';

const N = 20000;
const times = [];
// warmup
for (let i = 0; i < 500; i++) {
  const { system, user } = assembleMessages(INPUTS[i % INPUTS.length], { profile: PROFILE, strength: 'standard' });
  postprocess(system + user, 800);
}
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  const { system, user } = assembleMessages(INPUTS[i % INPUTS.length], { profile: PROFILE, strength: 'standard' });
  const cleaned = postprocess(`“${OUTPUT}”`, 800);
  checkRules(INPUTS[i % INPUTS.length], cleaned, { maxChars: 800 });
  if (system.length === 0 || user.length === 0) throw new Error('assembly broke');
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const p50 = times[Math.floor(N * 0.5)];
const p95 = times[Math.floor(N * 0.95)];
const mean = times.reduce((a, b) => a + b, 0) / N;

console.log(`engine overhead per enhancement (assemble + clean + rules), n=${N}`);
console.log(`  P50: ${p50.toFixed(3)}ms`);
console.log(`  P95: ${p95.toFixed(3)}ms`);
console.log(`  mean: ${mean.toFixed(3)}ms`);
if (p50 >= 5) {
  console.error('BUDGET VIOLATION: P50 must stay under 5ms');
  process.exit(1);
}
console.log('budget check: PASS (P50 < 5ms)');
