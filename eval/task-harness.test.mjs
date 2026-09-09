import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessRunner, loadTaskFixtures, normalizeObservation, runFormatGate, runTaskEvaluation, validateTaskFixtures } from './task-harness.mjs';

const FIXTURES = fileURLToPath(new URL('./task-fixtures.json', import.meta.url));

test('curated coding-agent fixtures are valid and pass the deterministic format gate', () => {
  const document = loadTaskFixtures(FIXTURES);
  assert.equal(document.profile, 'coding-agent');
  assert.equal(document.fixtures.length, 6);
  assert.equal(new Set(document.fixtures.map((fixture) => fixture.id)).size, document.fixtures.length);

  const gate = runFormatGate(document.fixtures);
  assert.equal(gate.passed, true, JSON.stringify(gate.failures));
  assert.equal(gate.checked, document.fixtures.length);
});

test('fixture validation rejects duplicate ids and non-coding profiles', () => {
  const base = {
    schemaVersion: 1,
    profile: 'coding-agent',
    fixtures: [{
      id: 'same',
      title: 'A task',
      source: 'test',
      original: 'Do the task',
      enhanced: 'Do the task carefully and keep the existing behavior.',
      acceptance: ['The task works.'],
      scope: { in: ['the task'], out: ['unrelated work'] }
    }]
  };
  assert.throws(() => validateTaskFixtures({ ...base, profile: 'writing' }), /profile must be coding-agent/);
  assert.throws(() => validateTaskFixtures({ ...base, fixtures: [base.fixtures[0], { ...base.fixtures[0] }] }), /duplicate fixture id/);
});

test('normalizes required task observations without inventing missing token cost', () => {
  const metrics = normalizeObservation({
    completion: true,
    retryCount: 1,
    followUpCount: 2,
    scopeDrift: { detected: true, items: ['added an unrequested file'] },
    hallucinationFlags: ['claimed an API that does not exist']
  }, { latencyMs: 42 });

  assert.deepEqual(metrics, {
    completion: true,
    retryCount: 1,
    followUpCount: 2,
    scopeDrift: { detected: true, items: ['added an unrequested file'] },
    hallucinationFlags: ['claimed an API that does not exist'],
    tokenCost: { inputTokens: null, outputTokens: null, totalTokens: null, usd: null, source: null },
    latencyMs: 42
  });
  assert.throws(() => normalizeObservation({
    completion: true,
    retryCount: 0,
    followUpCount: 0,
    scopeDrift: false,
    hallucinationFlags: []
  }), /latencyMs/);
});

test('paired evaluation runs both variants in stable order and aggregates observations', async () => {
  const document = loadTaskFixtures(FIXTURES);
  const calls = [];
  const report = await runTaskEvaluation({
    document,
    repetitions: 2,
    runner: async ({ fixture, variant, prompt, repetition }) => {
      calls.push({ id: fixture.id, variant, repetition, prompt });
      return {
        completion: variant === 'enhanced',
        retryCount: variant === 'original' ? 1 : 0,
        followUpCount: variant === 'original' ? 1 : 0,
        scopeDrift: variant === 'original',
        hallucinationFlags: variant === 'original' ? ['fixture-observation'] : [],
        tokenCost: { inputTokens: 10, outputTokens: 5, source: 'test' }
      };
    }
  });

  assert.equal(report.status, 'completed');
  assert.equal(report.runs.length, document.fixtures.length * 2 * 2);
  assert.deepEqual(calls.slice(0, 4).map((call) => [call.id, call.repetition, call.variant]), [
    ['cli-dry-run', 1, 'original'],
    ['cli-dry-run', 1, 'enhanced'],
    ['config-error-boundary', 1, 'original'],
    ['config-error-boundary', 1, 'enhanced']
  ]);
  assert.equal(report.summary.byVariant.original.completed, 0);
  assert.equal(report.summary.byVariant.enhanced.completed, document.fixtures.length * 2);
  assert.equal(report.summary.byVariant.original.scopeDrifted, document.fixtures.length * 2);
  assert.equal(report.summary.byVariant.enhanced.tokenCost.totalTokens, document.fixtures.length * 2 * 15);
  assert.equal(report.runs.every((run) => run.metrics.latencyMs >= 0), true);
});

test('a format-gate failure blocks all downstream runs', async () => {
  const document = loadTaskFixtures(FIXTURES);
  const bad = {
    ...document,
    fixtures: [{ ...document.fixtures[0], enhanced: '好的，以下是实现方案：先安装依赖。' }]
  };
  let invoked = false;
  const report = await runTaskEvaluation({
    document: bad,
    runner: async () => { invoked = true; return {}; }
  });

  assert.equal(report.status, 'blocked-by-format-gate');
  assert.equal(report.runs.length, 0);
  assert.equal(invoked, false);
  assert.deepEqual(report.formatGate.failures[0].failedRules.map((rule) => rule.id), ['lang-consistency', 'expand-not-answer']);
});

test('process runner enforces the JSON adapter contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-contract-task-runner-'));
  const runnerPath = join(directory, 'runner.mjs');
  await writeFile(runnerPath, `
    import { readFileSync } from 'node:fs';
    const request = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify({
      completion: request.variant === 'enhanced',
      retryCount: 0,
      followUpCount: 0,
      scopeDrift: false,
      hallucinationFlags: [],
      tokenCost: { inputTokens: 3, outputTokens: 2, source: 'test-runner' }
    }));
  `, 'utf8');

  try {
    const runner = createProcessRunner({ runnerPath, timeoutMs: 10000 });
    const observation = await runner({
      fixture: { id: 'adapter-test', title: 'Adapter test', source: 'test' },
      variant: 'enhanced',
      prompt: 'Do the task.',
      repetition: 1
    });
    assert.equal(observation.completion, true);
    assert.equal(observation.tokenCost.totalTokens, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
