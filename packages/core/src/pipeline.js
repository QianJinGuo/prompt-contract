/**
 * Core pipeline: assemble (profile + hard constraints + strength + context) → single LLM call
 * → deterministic postprocess. No middleware, no queues, no cache (PRD §7.6 / decision D8).
 */
import { PromptContractError, CODES, normalizeError } from './errors.js';
import { detectScriptName } from './lang.js';
import { postprocess } from './clean.js';

export const STRENGTHS = {
  polish: 'POLISH: The input is already adequate. Fix only wording, grammar, and clarity. Preserve its structure and length. Do not add new content.',
  standard: 'STANDARD: Make a substantive enhancement — clarify the task, its scope, constraints, and the expected output, while preserving the original intent.',
  expand: 'EXPAND: Turn the input into a structured task specification — goal, scope, explicit constraints, acceptance criteria, and edge cases. Stay realistic; do not invent features.'
};

/** Hard constraints appended to every request — mirror of eval/rules.js (PRD appendix: 共用同一份规格). */
export function hardConstraints({ maxChars, strength }) {
  return [
    'HARD CONSTRAINTS:',
    '1. LANGUAGE: Respond strictly in the same language as USER INPUT. Never output language labels or meta commentary about the language.',
    '2. OUTPUT ONLY THE ENHANCED PROMPT TEXT — no explanations, no preface, no markdown fences, no quotes around the whole text.',
    `3. Keep it under ${maxChars} characters, complete and concise; never end with a dangling list item or a trailing colon.`,
    '4. EXPAND, DO NOT ANSWER: never answer the request, never ask the user questions, never request code snippets; focus on WHAT is wanted, not HOW.',
    '5. If the input is already clear and specific, only lightly polish it.',
    '6. Do not invent facts and do not add requirements, features, or technologies the input does not mention.'
  ].join('\n');
}

/** Assemble the two-message request. Exported for tests and the MCP zero-key prompt mode. */
export function assembleMessages(text, { profile, strength = 'standard', context, maxChars } = {}) {
  const chars = maxChars ?? profile?.maxChars ?? 800;
  const strengthName = STRENGTHS[strength] ? strength : 'standard';
  const parts = [];
  if (profile?.body) parts.push(profile.body.trim());
  parts.push(hardConstraints({ maxChars: chars, strength }));
  parts.push(`STRENGTH MODE: ${STRENGTHS[strengthName]}`);
  const system = parts.join('\n\n');

  let user = `USER INPUT:\n${text}`;
  if (context && String(context).trim()) user += `\n\nCONTEXT (background information, do not enhance this part):\n${String(context).trim()}`;
  return { system, user, strength: strengthName, maxChars: chars };
}

/**
 * @param {string} text raw user prompt
 * @param {object} opts { profile, provider, model, strength, context, maxChars, signal, timeoutMs, onDelta }
 * @returns {Promise<{text, original, meta}>}
 */
export async function enhance(text, opts = {}) {
  if (!text || !String(text).trim()) throw new PromptContractError(CODES.EMPTY_INPUT, 'empty input');
  if (!opts.provider || typeof opts.provider.complete !== 'function') {
    throw new PromptContractError(CODES.CONFIG, 'no provider configured');
  }
  const { system, user, strength, maxChars } = assembleMessages(text, opts);
  const started = performance.now();
  let raw;
  try {
    const res = await opts.provider.complete({
      system,
      user,
      model: opts.model,
      signal: opts.signal,
      onDelta: opts.onDelta,
      maxTokens: Math.ceil(maxChars * 1.2), // CJK ≈ 1 token/char worst case
      timeoutMs: opts.timeoutMs ?? 30000
    });
    raw = res?.text ?? '';
  } catch (err) {
    throw normalizeError(err);
  }
  const cleaned = postprocess(raw, maxChars);
  if (cleaned === null) throw new PromptContractError(CODES.LLM_ERROR, 'provider returned an empty result');
  return {
    text: cleaned,
    original: text,
    meta: {
      profile: opts.profile?.name ?? null,
      strength,
      model: opts.model ?? null,
      script: detectScriptName(cleaned),
      chars: [...cleaned].length,
      ms: Math.round(performance.now() - started)
    }
  };
}
