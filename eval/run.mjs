#!/usr/bin/env node
/**
 * Deterministic eval runner — no network, no model needed.
 * Positives must pass every rule assertion; negatives must fail exactly the rule named in expectFail.
 * This is the acceptance gate described in docs/ACCEPTANCE.md (R16).
 */
import { readFileSync } from 'node:fs';
import { checkRules } from '../packages/core/src/rules.js';

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const profileMaxChars = { 'coding-agent': 800, writing: 800, 'image-gen': 600 };

let failures = 0;

console.log('== positives (must pass ALL rules) ==');
for (const c of cases.positives) {
  const maxChars = c.maxChars ?? profileMaxChars[c.profile] ?? 800;
  const { pass, results } = checkRules(c.original, c.enhanced, { maxChars });
  const bad = results.filter((r) => !r.pass);
  if (pass) {
    console.log(`  PASS  ${c.id}`);
  } else {
    failures++;
    console.log(`  FAIL  ${c.id}`);
    for (const r of bad) console.log(`        ${r.id}: ${r.detail}`);
  }
}

console.log('== negatives (must fail the named rule) ==');
for (const c of cases.negatives) {
  const { pass, results } = checkRules(c.original, c.enhanced, {});
  const failed = results.find((r) => !r.pass);
  if (!pass && failed.id === c.expectFail) {
    console.log(`  PASS  ${c.id} (correctly failed ${c.expectFail})`);
  } else if (!pass) {
    failures++;
    console.log(`  FAIL  ${c.id} failed "${failed.id}" but expected "${c.expectFail}"`);
  } else {
    failures++;
    console.log(`  FAIL  ${c.id} passed everything but expected failure on "${c.expectFail}"`);
  }
}

const total = cases.positives.length + cases.negatives.length;
console.log(`\neval: ${total - failures}/${total} cases pass`);
process.exit(failures === 0 ? 0 : 1);
