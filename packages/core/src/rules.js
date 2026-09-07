/**
 * The six hard constraints from the PRD appendix, as deterministic rule assertions.
 * Same spec drives three surfaces: `pb check` (CLI), playground badges, eval runner —
 * template and evaluation share one source of truth (PRD: 模板与评测共用同一份规格).
 */
import { detectScriptName } from './lang.js';

/** Common tech names — flagged when they appear in output but were never in the input (hard constraint #6). */
const TECH_DENYLIST = [
  'next.js', 'nuxt', 'react', 'vue', 'angular', 'svelte', 'tailwind', 'bootstrap', 'jquery',
  'django', 'flask', 'fastapi', 'spring', 'rails', 'laravel',
  'postgresql', 'mysql', 'mongodb', 'redis', 'sqlite',
  'docker', 'kubernetes', 'graphql', 'grpc', 'typescript', 'javascript', 'python', 'rust',
  'swift', 'kotlin', 'prisma', 'supabase', 'firebase', 'vercel', 'kafka', 'elasticsearch'
];

const ANSWER_OPENERS = /^(好的|当然[啦咯]?|没问题|明白了|收到|以下是|这是|here'?s\b|here is\b|sure\b[,!]|certainly\b|i'?(ll| will| can) (help|create|write|generate|provide|design|build))/i;
const META_LABELS = /^(enhanced\s*prompt|optimized\s*prompt|优化后的?提示?词|增强后的?提示?词|改写后|新提示词)\s*[:：]/i;
const WRAPPED_IN_QUOTES = /^['"“”‘’«»][\s\S]+['"“”‘’«»]$/;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function result(id, title, pass, detail) {
  return { id, title, pass, detail: detail || '' };
}

/**
 * Assert the hard constraints. `opts.maxChars` defaults to 800.
 * Rule 5 (`polish-when-clear`) is judge-only (needs semantic judgment) and intentionally absent here.
 */
export function checkRules(original, enhanced, opts = {}) {
  const maxChars = opts.maxChars ?? 800;
  const out = String(enhanced ?? '');
  const trimmed = out.trim();
  const results = [];

  results.push(result('non-empty', '输出非空', trimmed.length > 0, trimmed.length > 0 ? '' : 'empty output'));

  const inScript = detectScriptName(original || '');
  const outScript = detectScriptName(out);
  results.push(result(
    'lang-consistency', '语言一致性',
    inScript === outScript,
    `input=${inScript}, output=${outScript}`
  ));

  const hasFence = out.includes('```');
  const wrapped = WRAPPED_IN_QUOTES.test(trimmed);
  const hasMeta = META_LABELS.test(trimmed);
  results.push(result(
    'only-enhanced-text', '只输出增强文本',
    !hasFence && !wrapped && !hasMeta,
    [hasFence && 'markdown fence', wrapped && 'wrapping quotes', hasMeta && 'meta label'].filter(Boolean).join(', ')
  ));

  const chars = [...trimmed].length;
  const dangling = /([-*+]+|[:：])\s*$/.test(trimmed);
  results.push(result(
    'length-limit', '长度与完整性',
    chars > 0 && chars <= maxChars && !dangling,
    `${chars}/${maxChars} chars${dangling ? ', dangling colon/marker' : ''}`
  ));

  const endsWithQuestion = /[?？]\s*$/.test(trimmed);
  const opener = ANSWER_OPENERS.exec(trimmed);
  results.push(result(
    'expand-not-answer', '扩写而非回答',
    !opener && !endsWithQuestion,
    [opener && `answer opener "${opener[1]}"`, endsWithQuestion && 'ends with a question'].filter(Boolean).join(', ')
  ));

  const lowerOut = out.toLowerCase();
  const lowerIn = String(original ?? '').toLowerCase();
  const hallucinated = TECH_DENYLIST.filter((name) => lowerOut.includes(name) && !lowerIn.includes(name));
  results.push(result(
    'no-hallucinated-tech', '无未提及的技术栈',
    hallucinated.length === 0,
    hallucinated.length ? `added: ${hallucinated.join(', ')}` : ''
  ));

  return { pass: results.every((r) => r.pass), results };
}

export { escapeRe };
