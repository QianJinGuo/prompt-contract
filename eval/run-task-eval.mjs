#!/usr/bin/env node
/**
 * Run the paired task-level harness. This is separate from eval/run.mjs:
 * `run.mjs` is the deterministic format gate, while this command measures
 * downstream task observations supplied by a runner adapter.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  createFormatOnlyReport,
  createProcessRunner,
  loadTaskFixtures,
  runTaskEvaluation
} from './task-harness.mjs';

const DEFAULT_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'task-fixtures.json');

const USAGE = `Task-level PromptBoost evaluation

Format gate only (offline):
  npm run eval:tasks -- --format-only

Run a downstream coding-agent adapter:
  npm run eval:tasks -- --runner ./path/to/runner.mjs --repetitions 3 --output /tmp/pb-task-eval.json

Options:
  --fixtures <path>       fixture JSON (default: eval/task-fixtures.json)
  --runner <path>         Node runner implementing the JSON stdin/stdout contract
  --repetitions <n>       paired runs per fixture (default: 1)
  --timeout-ms <n>        runner timeout per variant (default: 600000)
  --max-chars <n>         coding-agent enhanced prompt cap (default: 800)
  --output <path>         write the complete JSON report
  --json                  print the complete JSON report to stdout
  --format-only           validate the deterministic format gate without a runner
  --help                  show this help`;

function parseArgs(argv) {
  const flags = { _: [] };
  const needsValue = new Set(['--fixtures', '--runner', '--repetitions', '--timeout-ms', '--max-chars', '--output']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--format-only') flags.formatOnly = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (needsValue.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      flags[arg.slice(2).replaceAll('-', '_')] = value;
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else flags._.push(arg);
  }
  return flags;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function printSummary(report) {
  const gate = report.formatGate;
  const passedCases = gate.cases.filter((item) => item.pass).length;
  const lines = [
    `task eval: ${report.status}`,
    `format gate: ${gate.passed ? 'PASS' : 'FAIL'} (${passedCases}/${gate.checked})`
  ];
  if (!gate.passed) {
    for (const failure of gate.failures) {
      lines.push(`  ${failure.id}: ${failure.failedRules.map((rule) => rule.id).join(', ')}`);
    }
  }
  for (const variant of ['original', 'enhanced']) {
    const item = report.summary.byVariant[variant];
    lines.push(`  ${variant}: completed ${item.completed}/${item.validObservations}; runner errors ${item.runnerErrors}; latency ${item.latencyMs === null ? 'n/a' : `${item.latencyMs.toFixed(1)}ms`}`);
  }
  return lines.join('\n');
}

function writeReport(report, outputPath) {
  if (!outputPath) return;
  const absolute = resolve(outputPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  const fixturePath = resolve(flags.fixtures || DEFAULT_FIXTURES);
  const document = loadTaskFixtures(fixturePath);
  const maxChars = flags.max_chars === undefined ? 800 : positiveInteger(flags.max_chars, '--max-chars');
  const fixtureFile = flags.fixtures || DEFAULT_FIXTURES;

  if (flags.formatOnly) {
    const report = createFormatOnlyReport(document, { maxChars, fixtureFile });
    writeReport(report, flags.output);
    process.stdout.write(flags.json ? JSON.stringify(report, null, 2) + '\n' : printSummary(report) + '\n');
    return report.formatGate.passed ? 0 : 1;
  }

  if (!flags.runner) throw new Error('--runner is required unless --format-only is used');
  const runner = createProcessRunner({
    runnerPath: resolve(flags.runner),
    timeoutMs: flags.timeout_ms === undefined ? 600000 : positiveInteger(flags.timeout_ms, '--timeout-ms')
  });
  const repetitions = flags.repetitions === undefined ? 1 : positiveInteger(flags.repetitions, '--repetitions');
  const report = await runTaskEvaluation({ document, runner, repetitions, maxChars, fixtureFile });
  writeReport(report, flags.output);
  process.stdout.write(flags.json ? JSON.stringify(report, null, 2) + '\n' : printSummary(report) + '\n');
  return report.status === 'completed' ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`task eval: ${error.code || 'error'}: ${error.message}\n`);
  process.exit(2);
});
