/**
 * Profile format: Markdown + minimal frontmatter — community-contribution surface (PRD §3.2: "PR 即贡献").
 * YAML subset only: `key: value` scalars (string/number/bool) and `key:` + indented `- item` lists.
 */
import { PromptBoostError, CODES } from './errors.js';

export function parseYamlLite(src) {
  const out = {};
  let currentListKey = null;
  for (const rawLine of src.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const listItem = rawLine.match(/^\s+-\s+(.*)$/);
    if (listItem) {
      if (!currentListKey) throw new PromptBoostError(CODES.CONFIG, `list item without a parent key: "${rawLine.trim()}"`);
      out[currentListKey].push(coerce(listItem[1].trim()));
      continue;
    }
    const kv = rawLine.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) throw new PromptBoostError(CODES.CONFIG, `unparsable frontmatter line: "${rawLine.trim()}"`);
    const [, key, value] = kv;
    currentListKey = null;
    if (value === '') { out[key] = []; currentListKey = key; } else { out[key] = coerce(value.trim()); }
  }
  return out;
}

function coerce(v) {
  if (/^(true|false)$/.test(v)) return v === 'true';
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v, 10);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function parseProfile(markdown, { path } = {}) {
  const m = String(markdown).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new PromptBoostError(CODES.CONFIG, `profile${path ? ` ${path}` : ''}: missing frontmatter block`);
  const meta = parseYamlLite(m[1]);
  if (!meta.name || typeof meta.name !== 'string') {
    throw new PromptBoostError(CODES.CONFIG, `profile${path ? ` ${path}` : ''}: frontmatter must declare a string "name"`);
  }
  return {
    name: meta.name,
    domain: typeof meta.domain === 'string' ? meta.domain : '',
    maxChars: Number.isFinite(meta.maxChars) && meta.maxChars > 0 ? meta.maxChars : 800,
    noUnmentionedTech: meta.noUnmentionedTech !== false,
    body: m[2].trim(),
    path
  };
}
