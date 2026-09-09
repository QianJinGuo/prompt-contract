/**
 * Small, dependency-free task-level evaluation harness.
 *
 * The harness owns pairing, format gating, process timing, schema validation,
 * and aggregation. A runner owns the downstream coding-agent execution and
 * must report task-level observations for each prompt variant.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { checkRules } from '../packages/core/src/rules.js';

export const TASK_EVAL_SCHEMA_VERSION = 1;
export const TASK_EVAL_PROFILE = 'coding-agent';
export const TASK_EVAL_VARIANTS = ['original', 'enhanced'];

function protocolError(message, code = 'runner_protocol_error') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field, { nonEmpty = true } = {}) {
  if (typeof value !== 'string' || (nonEmpty && !value.trim())) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw protocolError(`${field} must be a non-negative integer`);
  }
  return value;
}

function requireNonNegativeNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw protocolError(`${field} must be a non-negative number`);
  }
  return value;
}

function optionalNonNegativeInteger(value, field) {
  if (value === null || value === undefined) return null;
  return requireNonNegativeInteger(value, field);
}

function optionalNonNegativeNumber(value, field) {
  if (value === null || value === undefined) return null;
  return requireNonNegativeNumber(value, field);
}

function uniqueStrings(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

/**
 * Validate and normalize the fixture document. Fixtures deliberately contain
 * both prompt variants: this makes a run replayable and keeps prompt
 * generation separate from downstream task measurement.
 */
export function validateTaskFixtures(document, { profile = TASK_EVAL_PROFILE } = {}) {
  if (!isObject(document)) throw new TypeError('task fixture document must be an object');
  if (document.schemaVersion !== TASK_EVAL_SCHEMA_VERSION) {
    throw new TypeError(`unsupported task fixture schemaVersion: ${document.schemaVersion}`);
  }
  if (document.profile !== profile) {
    throw new TypeError(`task fixture profile must be ${profile}`);
  }
  if (!Array.isArray(document.fixtures) || document.fixtures.length === 0) {
    throw new TypeError('task fixture document must contain at least one fixture');
  }

  const ids = new Set();
  const fixtures = document.fixtures.map((fixture, index) => {
    if (!isObject(fixture)) throw new TypeError(`fixtures[${index}] must be an object`);
    const id = requireString(fixture.id, `fixtures[${index}].id`).trim();
    if (ids.has(id)) throw new TypeError(`duplicate fixture id: ${id}`);
    ids.add(id);

    const scope = fixture.scope;
    if (!isObject(scope)) throw new TypeError(`fixtures[${index}].scope must be an object`);

    return {
      ...fixture,
      id,
      title: requireString(fixture.title, `fixtures[${index}].title`).trim(),
      source: requireString(fixture.source, `fixtures[${index}].source`).trim(),
      original: requireString(fixture.original, `fixtures[${index}].original`),
      enhanced: requireString(fixture.enhanced, `fixtures[${index}].enhanced`),
      acceptance: uniqueStrings(fixture.acceptance, `fixtures[${index}].acceptance`),
      scope: {
        ...scope,
        in: uniqueStrings(scope.in, `fixtures[${index}].scope.in`),
        out: uniqueStrings(scope.out, `fixtures[${index}].scope.out`)
      }
    };
  });

  return { ...document, profile, fixtures };
}

export function loadTaskFixtures(filePath) {
  const document = JSON.parse(readFileSync(filePath, 'utf8'));
  return validateTaskFixtures(document);
}

/**
 * Deterministic rules are a hard precondition. A failed enhanced prompt is
 * reported, but no downstream runner is invoked for any fixture.
 */
export function runFormatGate(fixtures, { maxChars = 800, check = checkRules } = {}) {
  const cases = fixtures.map((fixture) => {
    const rules = check(fixture.original, fixture.enhanced, { maxChars });
    return { id: fixture.id, pass: rules.pass, results: rules.results };
  });
  const failures = cases
    .filter((item) => !item.pass)
    .map((item) => ({
      id: item.id,
      failedRules: item.results.filter((rule) => !rule.pass).map(({ id, detail }) => ({ id, detail }))
    }));
  const passed = failures.length === 0;
  return { passed, pass: passed, checked: cases.length, maxChars, cases, failures };
}

function normalizeScopeDrift(value) {
  if (typeof value === 'boolean') return { detected: value, items: [] };
  if (!isObject(value)) throw protocolError('scopeDrift must be a boolean or object');
  const detected = value.detected ?? value.drifted;
  if (typeof detected !== 'boolean') throw protocolError('scopeDrift.detected must be a boolean');
  const rawItems = value.items ?? value.reasons ?? [];
  return { detected, items: uniqueStrings(rawItems, 'scopeDrift.items') };
}

function normalizeTokenCost(value) {
  if (value === undefined || value === null) {
    return { inputTokens: null, outputTokens: null, totalTokens: null, usd: null, source: null };
  }
  if (!isObject(value)) throw protocolError('tokenCost must be an object or null');
  const inputTokens = optionalNonNegativeInteger(value.inputTokens ?? value.input, 'tokenCost.inputTokens');
  const outputTokens = optionalNonNegativeInteger(value.outputTokens ?? value.output, 'tokenCost.outputTokens');
  const totalTokens = optionalNonNegativeInteger(
    value.totalTokens ?? value.total ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    'tokenCost.totalTokens'
  );
  const usd = optionalNonNegativeNumber(value.usd ?? value.costUsd ?? value.amountUsd, 'tokenCost.usd');
  const source = value.source === undefined || value.source === null
    ? null
    : requireString(value.source, 'tokenCost.source').trim();
  return { inputTokens, outputTokens, totalTokens, usd, source };
}

/**
 * Normalize one runner response. Counts are required for successful runner
 * observations so missing telemetry cannot silently become a zero.
 */
export function normalizeObservation(observation, { latencyMs } = {}) {
  if (!isObject(observation)) throw protocolError('runner output must be a JSON object');
  if (typeof observation.completion !== 'boolean') {
    throw protocolError('completion must be a boolean');
  }
  const retryCount = requireNonNegativeInteger(
    observation.retryCount ?? observation.retries,
    'retryCount'
  );
  const followUpCount = requireNonNegativeInteger(
    observation.followUpCount ?? observation.followUps,
    'followUpCount'
  );
  const rawFlags = observation.hallucinationFlags ?? observation.hallucinations;
  const hallucinationFlags = uniqueStrings(rawFlags, 'hallucinationFlags');
  const measuredLatencyMs = requireNonNegativeNumber(latencyMs, 'latencyMs');

  return {
    completion: observation.completion,
    retryCount,
    followUpCount,
    scopeDrift: normalizeScopeDrift(observation.scopeDrift),
    hallucinationFlags,
    tokenCost: normalizeTokenCost(observation.tokenCost ?? observation.tokens),
    latencyMs: measuredLatencyMs
  };
}

function unavailableMetrics(latencyMs) {
  return {
    completion: false,
    retryCount: null,
    followUpCount: null,
    scopeDrift: { detected: null, items: [] },
    hallucinationFlags: [],
    tokenCost: { inputTokens: null, outputTokens: null, totalTokens: null, usd: null, source: null },
    latencyMs
  };
}

function serializeError(error) {
  return {
    code: error?.code || 'runner_error',
    message: String(error?.message || error).split(/\r?\n/, 1)[0].slice(0, 240)
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sumKnown(values, expectedCount) {
  const known = values.filter((value) => value !== null && value !== undefined);
  return known.length === expectedCount && expectedCount > 0
    ? known.reduce((sum, value) => sum + value, 0)
    : null;
}

function summarizeVariant(runs, variant) {
  const variantRuns = runs.filter((run) => run.variant === variant);
  const validRuns = variantRuns.filter((run) => run.status === 'ok');
  const metrics = validRuns.map((run) => run.metrics);
  const completed = metrics.filter((item) => item.completion).length;
  const scopeDrifted = metrics.filter((item) => item.scopeDrift.detected === true).length;
  const hallucinationRuns = metrics.filter((item) => item.hallucinationFlags.length > 0).length;
  const tokenCosts = metrics.map((item) => item.tokenCost);

  return {
    attempts: variantRuns.length,
    validObservations: validRuns.length,
    runnerErrors: variantRuns.length - validRuns.length,
    completed,
    completionRate: validRuns.length ? completed / validRuns.length : null,
    retryCount: mean(metrics.map((item) => item.retryCount)),
    followUpCount: mean(metrics.map((item) => item.followUpCount)),
    scopeDrifted,
    scopeDriftRate: validRuns.length ? scopeDrifted / validRuns.length : null,
    hallucinationRuns,
    hallucinationFlagCount: metrics.reduce((sum, item) => sum + item.hallucinationFlags.length, 0),
    tokenCost: {
      inputTokens: sumKnown(tokenCosts.map((item) => item.inputTokens), validRuns.length),
      outputTokens: sumKnown(tokenCosts.map((item) => item.outputTokens), validRuns.length),
      totalTokens: sumKnown(tokenCosts.map((item) => item.totalTokens), validRuns.length),
      usd: sumKnown(tokenCosts.map((item) => item.usd), validRuns.length),
      knownObservations: tokenCosts.filter((item) => item.totalTokens !== null || item.usd !== null).length
    },
    latencyMs: mean(metrics.map((item) => item.latencyMs))
  };
}

export function summarizeRuns(runs) {
  return {
    byVariant: {
      original: summarizeVariant(runs, 'original'),
      enhanced: summarizeVariant(runs, 'enhanced')
    }
  };
}

function validateRepetitions(repetitions) {
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new TypeError('repetitions must be a positive integer');
  }
  return repetitions;
}

/**
 * Run fixtures in stable fixture order, repetition order, then original /
 * enhanced order. The function intentionally emits grouped observations only;
 * it does not turn them into an effectiveness verdict.
 */
export async function runTaskEvaluation({
  document,
  fixtures = document?.fixtures,
  runner,
  repetitions = 1,
  maxChars = 800,
  fixtureFile = null
} = {}) {
  const normalizedDocument = validateTaskFixtures(document ?? {
    schemaVersion: TASK_EVAL_SCHEMA_VERSION,
    profile: TASK_EVAL_PROFILE,
    fixtures
  });
  const count = validateRepetitions(repetitions);
  const formatGate = runFormatGate(normalizedDocument.fixtures, { maxChars });
  const report = {
    schemaVersion: TASK_EVAL_SCHEMA_VERSION,
    kind: 'promptboost-task-evaluation',
    profile: normalizedDocument.profile,
    fixtureFile,
    fixtureCount: normalizedDocument.fixtures.length,
    repetitions: count,
    executionOrder: 'fixture order × repetition × original, enhanced',
    formatGate,
    status: formatGate.passed ? 'ready' : 'blocked-by-format-gate',
    runs: [],
    summary: summarizeRuns([])
  };

  if (!formatGate.passed) return report;
  if (typeof runner !== 'function') {
    report.status = 'runner-required';
    report.errors = [{ code: 'runner_required', message: 'a downstream runner is required after the format gate passes' }];
    return report;
  }

  const errors = [];
  for (let repetition = 1; repetition <= count; repetition++) {
    for (const fixture of normalizedDocument.fixtures) {
      for (const variant of TASK_EVAL_VARIANTS) {
        const started = performance.now();
        const prompt = fixture[variant];
        try {
          const observation = await runner({ fixture, variant, prompt, repetition });
          const latencyMs = Math.max(0, Math.round(performance.now() - started));
          const metrics = normalizeObservation(observation, { latencyMs });
          report.runs.push({ fixtureId: fixture.id, title: fixture.title, repetition, variant, prompt, status: 'ok', metrics });
        } catch (error) {
          const latencyMs = Math.max(0, Math.round(performance.now() - started));
          const serialized = serializeError(error);
          errors.push({ fixtureId: fixture.id, repetition, variant, error: serialized });
          report.runs.push({
            fixtureId: fixture.id,
            title: fixture.title,
            repetition,
            variant,
            prompt,
            status: 'runner-error',
            error: serialized,
            metrics: unavailableMetrics(latencyMs)
          });
        }
      }
    }
  }

  report.errors = errors;
  report.status = errors.length ? 'runner-errors' : 'completed';
  report.summary = summarizeRuns(report.runs);
  return report;
}

export function createFormatOnlyReport(document, { maxChars = 800, fixtureFile = null } = {}) {
  const normalizedDocument = validateTaskFixtures(document);
  const formatGate = runFormatGate(normalizedDocument.fixtures, { maxChars });
  return {
    schemaVersion: TASK_EVAL_SCHEMA_VERSION,
    kind: 'promptboost-task-evaluation',
    profile: normalizedDocument.profile,
    fixtureFile,
    fixtureCount: normalizedDocument.fixtures.length,
    repetitions: 0,
    executionOrder: null,
    formatGate,
    status: formatGate.passed ? 'format-gate-passed' : 'blocked-by-format-gate',
    runs: [],
    summary: summarizeRuns([])
  };
}

/**
 * Adapt an executable Node runner to the in-process runner function.
 * The child receives one JSON object on stdin and must print exactly one JSON
 * object on stdout. Stderr is intentionally not persisted in reports.
 */
export function createProcessRunner({ runnerPath, cwd = process.cwd(), env = process.env, timeoutMs = 600000 } = {}) {
  requireString(runnerPath, 'runnerPath');
  requireNonNegativeInteger(timeoutMs, 'timeoutMs');
  if (timeoutMs === 0) throw new TypeError('timeoutMs must be greater than zero');

  return ({ fixture, variant, prompt, repetition }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd,
      env: {
        ...env,
        CONTRACT_EVAL_PROFILE: TASK_EVAL_PROFILE,
        CONTRACT_EVAL_FIXTURE_ID: fixture.id,
        CONTRACT_EVAL_VARIANT: variant,
        CONTRACT_EVAL_REPETITION: String(repetition)
      },
      stdio: ['pipe', 'pipe', 'ignore']
    });
    let stdout = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) return reject(protocolError(`runner timed out after ${timeoutMs}ms`, 'runner_timeout'));
      if (code !== 0) return reject(protocolError(`runner exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`, 'runner_exit'));
      const text = stdout.trim();
      if (!text) return reject(protocolError('runner returned no JSON output', 'runner_empty_output'));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(protocolError('runner stdout was not a single JSON object', 'runner_invalid_json'));
      }
    });
    child.stdin.end(JSON.stringify({
      schemaVersion: TASK_EVAL_SCHEMA_VERSION,
      profile: TASK_EVAL_PROFILE,
      fixture: {
        id: fixture.id,
        title: fixture.title,
        source: fixture.source,
        acceptance: fixture.acceptance,
        scope: fixture.scope
      },
      variant,
      prompt,
      repetition
    }) + '\n');
  });
}
