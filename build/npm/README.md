# ✨ PromptBoost

[![CI](https://github.com/QianJinGuo/prompt-boost/actions/workflows/ci.yml/badge.svg)](https://github.com/QianJinGuo/prompt-boost/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
[![GitHub release](https://img.shields.io/github/v/tag/QianJinGuo/prompt-boost?sort=semver)](https://github.com/QianJinGuo/prompt-boost/releases)

English · [简体中文](README.zh-CN.md)

![PromptBoost playground running the self-contained demo: a vague one-line request enhanced into a structured task spec, with six rule assertions passing](docs/assets/hero-playground.png)
<sub>The playground running its self-contained demo (`?demo=1`) against the local mock upstream — actual pipeline output, six rule assertions passing.</sub>

**PromptBoost is a deterministic prompt-contract layer for AI coding agents.** It compiles a vague one-line request into a structured task specification — goal, scope, constraints, acceptance criteria — and verifies the result against six hard rules before you ever see it.

It is *not* a smarter brain: your model does the thinking, PromptBoost makes the input stable, reviewable, and portable across models and tools.

## Why PromptBoost

- **Stable agent inputs** — a profile plus hard constraints turn "a website for my dog" into goal / scope / acceptance criteria / explicit non-goals. Fewer retries, less scope drift, no invented tech stacks.
- **Six deterministic guardrails** — language consistency, enhanced-text-only, length & completeness, expand-don't-answer, no hallucinated tech. Every enhancement can be asserted with `pb check`; the same spec drives templates and tests.
- **One engine, three surfaces** — a CLI, an MCP server (agent-invoked **tool** + user-invoked **slash prompts**), and a browser playground. All share one zero-dependency core.
- **Private by architecture** — bring your own key, no server in the middle, no telemetry, offline-capable via Ollama.

## Quick start — 30 seconds, no API key

```bash
git clone https://github.com/QianJinGuo/prompt-boost && cd prompt-boost
node mock/server.js &                                   # local mock upstream
node packages/cli/bin/pb.js "帮我做一个展示我家狗的网站" \
  --provider openai --base-url http://127.0.0.1:8787/v1 --api-key test-key-123 --model mock-model
node packages/playground/serve.js                       # → http://127.0.0.1:8123/  (or ?demo=1 for the self-running demo)
```

Once [`prompt-boost`](https://www.npmjs.com/package/prompt-boost) is on npm: `npx prompt-boost "your vague idea"`.

## Your real model

```bash
export PB_API_KEY=sk-xxx PB_MODEL=gpt-4o-mini    # any OpenAI-compatible endpoint (DeepSeek, Qwen, GLM, vLLM…)
pb "A website for my dog"

export PB_PROVIDER=ollama PB_MODEL=qwen3:4b      # fully local/offline; keep_alive pins the model in RAM
pb "帮我写一封请假邮件"
```

Or write `~/.prompt-boost/config.json` once: `{ "provider": "openai", "baseUrl": "…", "apiKey": "…", "model": "…" }`.

## MCP integration

```json
{ "mcpServers": { "prompt-boost": { "command": "node", "args": ["/abs/path/packages/mcp-server/bin/prompt-boost-mcp.js"] } } }
```

| Mode | Invocation | Needs a key? |
|---|---|---|
| **Tool** `enhance_prompt(text, profile?, strength?, context?)` | the agent calls it before executing a vague task | yes (your configured provider) |
| **Prompts** `/boost-coding-agent`, `/boost-writing`, `/boost-image-gen` | you invoke; the rewrite spec is injected into the **client's own model** | **no — zero config, server starts unconfigured** |

## Choose a profile

| Profile | Turns vague input into | Output cap |
|---|---|---|
| `coding-agent` | goal, scope, acceptance criteria, non-goals for a coding agent | 800 chars |
| `writing` | audience, tone, structure, preservation constraints | 800 chars |
| `image-gen` | subject, composition, lighting, style | 600 chars |

Community profiles are the main contribution surface — a PR adding `profiles/<name>.md` plus eval cases is a complete contribution (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Quality gates — and their honest limits

```bash
npm test        # 55 tests: engine units + SSE/ndjson streaming + CLI/MCP e2e against a local mock
npm run eval    # 9 deterministic cases over the six hard-constraint assertions
npm run bench   # engine overhead: P50 ≈ 0.005ms (budget < 5ms)
```

**What this does and does not prove:** these gates prove the *pipeline* is correct (streaming, cancellation, error codes, MCP handshake) and that outputs pass format constraints. They do **not** yet prove that enhanced prompts improve downstream task outcomes — that is the open validation item, defined as a task-level eval in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) (baseline vs enhanced on a real task set: completion rate, retries, scope drift, hallucinations, token cost). We prefer stating that openly over implying otherwise.

## How it works

```
raw input → script/scenario detect → profile + hard constraints + strength (+ optional context)
  → single streaming LLM call (small fast model by default; the model does the thinking)
  → deterministic cleaning (quotes/fences/length clamp, empty → llm_error)
  → { enhanced, original, meta } — original always preserved, one-key revert in every surface
```

## Status & roadmap — stated honestly

- **Shipped:** engine, CLI (`pb` / `check` / `doctor` / `profiles` / `spike-0`), MCP server (tool + zero-key prompts), playground, 3 profiles, eval cases, CI matrix.
- **Gated:** `pb watch` (global-hotkey resident mode) remains intentionally unavailable. `pb spike-0` measures macOS capture/clipboard safety and dry-run focus eligibility, but never pastes or unlocks watch by itself; see [docs/SPIKE-0.md](docs/SPIKE-0.md).
- **Open validation:** task-level outcome evaluation (above). Prompt enhancement is a competitive space with built-in features in major products; the durable value we pursue is stable, portable, privacy-preserving agent inputs — and that value is a hypothesis until the task-level eval says otherwise.
- Deferred: animated demo asset, IDE plugins, LLM-as-judge as *one* scorer inside the task-level eval.

## Layout

`packages/core` (engine, browser-safe, zero deps) · `packages/providers` (OpenAI-compatible SSE + Ollama `keep_alive`) · `packages/cli` · `packages/mcp-server` · `packages/playground` · `profiles/` · `eval/` · `mock/` · `docs/ACCEPTANCE.md` · `docs/SPIKE-0.md` (requirements → implementation → acceptance + evidence boundaries)

## Contributing & License

[CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Security policy](SECURITY.md) · Apache-2.0
