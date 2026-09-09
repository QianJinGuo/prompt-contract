# Task-level evaluation harness

This repository now includes a small paired harness for the `coding-agent` profile. It keeps the existing deterministic `checkRules` evaluation as a hard format gate, then (only when that gate passes) sends each fixture's `original` and `enhanced` prompt to the same downstream runner.

Run the offline gate:

```bash
npm run eval:tasks -- --format-only
```

Run task observations with an adapter:

```bash
npm run eval:tasks -- \
  --runner ./path/to/runner.mjs \
  --repetitions 3 \
  --output /tmp/prompt-contract-task-eval.json \
  --json
```

The runner is deliberately an adapter rather than a built-in model integration. The harness invokes it once per fixture, repetition, and variant, in stable order (`fixture order → repetition → original → enhanced`). It sends one JSON object on stdin:

```json
{
  "schemaVersion": 1,
  "profile": "coding-agent",
  "fixture": {
    "id": "cli-dry-run",
    "title": "Add a safe dry-run mode to an existing CLI",
    "source": "curated-repository-maintenance",
    "acceptance": ["..."],
    "scope": {"in": ["..."], "out": ["..."]}
  },
  "variant": "original",
  "prompt": "...",
  "repetition": 1
}
```

The runner must print one JSON object on stdout. Its observation must contain:

```json
{
  "completion": true,
  "retryCount": 0,
  "followUpCount": 0,
  "scopeDrift": {"detected": false, "items": []},
  "hallucinationFlags": [],
  "tokenCost": {
    "inputTokens": 1200,
    "outputTokens": 480,
    "totalTokens": 1680,
    "usd": null,
    "source": "provider-usage"
  }
}
```

`latencyMs` is measured by the harness around the runner process, so a runner's self-reported timing is not used as the end-to-end value. Unknown token usage stays `null`; the harness never turns missing telemetry into zero. `usd` is optional because pricing is model- and provider-specific.

Runner errors are recorded separately and excluded from valid-observation rates; they must be fixed or explicitly handled before interpreting a comparison.

## Evidence boundary

`eval/task-fixtures.json` is a curated repository-maintenance fixture set with concrete acceptance and scope contracts plus frozen original/enhanced prompt pairs. It is an evaluation input, not evidence that an agent completed those tasks. The harness records downstream observations but does not independently inspect a repository, infer scope drift, or decide whether a claimed API is hallucinated; the runner must perform those checks against the task's acceptance and scope contract.

The report is descriptive and grouped by `original` / `enhanced`. It does not emit an effectiveness verdict or claim that PromptBoost improves completion, retries, drift, hallucinations, cost, or latency. Such claims require actual runs, a declared runner/model/environment, enough repetitions for the intended comparison, and review of the raw report. The deterministic gate proves only prompt-format compliance; it is not a task-success score. No task results are committed to this repository.
