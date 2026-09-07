/**
 * Script-level language detection (heuristic, zero-cost — PRD §5.2: no extra LLM call).
 * Used for meta info and the `lang-consistency` rule assertion, not for prompt injection.
 */

const SCRIPT_TESTS = [
  ['kana', /[\u3040-\u309f\u30a0-\u30ff]/],
  ['hangul', /[\uac00-\ud7af\u1100-\u11ff]/],
  ['han', /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/],
  ['cyrillic', /[\u0400-\u04ff]/],
  ['arabic', /[\u0600-\u06ff]/],
  ['devanagari', /[\u0900-\u097f]/],
  ['thai', /[\u0e00-\u0e7f]/],
  ['hebrew', /[\u0590-\u05ff]/],
  ['greek', /[\u0370-\u03ff]/]
];

/**
 * Return the dominant script name of `text`.
 * Kana beats han on purpose: Japanese text mixes both, so any kana presence means Japanese;
 * Chinese input has no kana, which makes zh↔ja confusion detectable by the lang-consistency rule.
 */
export function detectScriptName(text) {
  if (!text) return 'latin';
  const counts = { kana: 0, hangul: 0, han: 0, cyrillic: 0, arabic: 0, devanagari: 0, thai: 0, hebrew: 0, greek: 0 };
  for (const ch of text) {
    for (const [name, re] of SCRIPT_TESTS) {
      if (re.test(ch)) { counts[name]++; break; }
    }
  }
  if (counts.kana > 0) return 'japanese';
  let best = null, bestN = 0;
  for (const [name] of SCRIPT_TESTS) {
    if (counts[name] > bestN) { best = name; bestN = counts[name]; }
  }
  return best || 'latin';
}
