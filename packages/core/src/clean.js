/**
 * Deterministic post-processing of LLM output — the layer WorkBuddy calls "清洗" (PRD §1.2).
 * No LLM output reaches a user surface without passing through here.
 */

const QUOTE_PAIRS = [
  ['"', '"'], ["'", "'"],
  ['\u201c', '\u201d'], // “ ”
  ['\u2018', '\u2019'], // ‘ ’
  ['\u00ab', '\u00bb'], // « »
  ['\u300c', '\u300d']  // 「 」
];

/** Remove wrapping quote pairs, repeatedly (WorkBuddy stripWrappingQuotes, generalized). */
export function stripWrappingQuotes(t) {
  let prev;
  do {
    prev = t;
    t = t.trim();
    for (const [open, close] of QUOTE_PAIRS) {
      if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) {
        t = t.slice(1, -1).trim();
        break;
      }
    }
  } while (t !== prev);
  return t;
}

/** Strip markdown code fences (hard constraint #2: no fences in output). */
export function stripFences(t) {
  const fenced = t.match(/^\s*```[\w+-]*\s*\r?\n([\s\S]*?)\r?\n?```\s*$/);
  if (fenced) return fenced[1];
  return t.replace(/^\s*```[\w+-]*\s*\r?\n?/, '').replace(/\r?\n?```\s*$/, '');
}

/**
 * Clamp to maxChars at a sentence boundary; never leave a dangling list marker or trailing colon
 * (hard constraint #3). Counts code points, not UTF-16 units.
 */
export function clampChars(t, maxChars) {
  const chars = [...t];
  if (chars.length <= maxChars) return t;
  const cut = chars.slice(0, maxChars).join('');
  const sentence = cut.match(/[\s\S]*[.!?。！？；;\n]/);
  let out = (sentence ? sentence[0] : cut).replace(/([-*+]+|[:：])\s*$/, '').trimEnd();
  if (!out) out = cut.trimEnd();
  return out;
}

export function postprocess(raw, maxChars) {
  let t = String(raw ?? '');
  t = stripFences(t);
  t = stripWrappingQuotes(t);
  t = t.trim();
  if (!t) return null; // caller maps to llm_error (WorkBuddy: empty result → llm_error)
  return clampChars(t, maxChars);
}
