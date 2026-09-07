# ✨ PromptBoost

**The open-source one-key prompt enhancement engine: turn vague ideas into structured task specs wherever you type to an AI.**

Inspired by WorkBuddy's "Boost Prompt" (whose reverse-engineered internals motivated this design), but with the opposite positioning: WorkBuddy locks the capability inside its own IDE; PromptBoost is an **open engine with thin shells everywhere** — CLI, MCP server, and a browser playground sharing one zero-dependency core.

> Current status: the M0 minimal set. The resident hotkey mode (`pb watch`) is gated by decision D7 — it ships only after the capture/paste-back link passes the Spike-0 validation.

## Quick start (no install, Node ≥ 20, zero dependencies)

```bash
node mock/server.js &                 # local mock upstream (no key, no network)
node packages/cli/bin/pb.js "帮我做一个展示我家狗的网站" \
  --provider openai --base-url http://127.0.0.1:8787/v1 --api-key test-key-123 --model mock-model
node packages/playground/serve.js     # → http://127.0.0.1:8123/
```

## Bring your own model

```bash
export PB_API_KEY=sk-xxx PB_MODEL=gpt-4o-mini   # any OpenAI-compatible endpoint
pb "A website for my dog"

export PB_PROVIDER=ollama PB_MODEL=qwen3:4b     # local, offline; keep_alive pins the model in RAM
pb "帮我写一封请假邮件"
```

Config file alternative: `~/.prompt-boost/config.json` with `{provider, baseUrl, apiKey, model}`.

## MCP integration

```json
{ "mcpServers": { "prompt-boost": { "command": "node", "args": ["/abs/path/packages/mcp-server/bin/prompt-boost-mcp.js"] } } }
```

- **Tool mode** — agents self-invoke `enhance_prompt(text, profile?, strength?, context?)`; the server enhances via your configured model.
- **Prompt mode (zero-key)** — slash commands (`/boost-coding-agent`, `/boost-writing`, `/boost-image-gen`) inject the rewrite spec into the *client's own model*; no API key required.

## Quality gates

```bash
npm test        # 43 tests: engine units + SSE/ndjson streaming + CLI/MCP e2e against a local mock
npm run eval    # 9 deterministic cases over the six hard-constraint rule assertions
npm run bench   # engine overhead: P50 0.004ms (budget < 5ms)
```

**Honest performance note:** the engine itself costs microseconds; end-to-end latency is dominated by model TTFT — which is why "route to a small fast model by default" is the first latency decision (see plan §7.6).

## The six hard constraints (one spec for template and eval)

1. Language consistency, no language labels · 2. Output only the enhanced text · 3. ≤800 chars, no dangling markers · 4. Expand, don't answer · 5. Light polish when already clear (judge-only) · 6. No invented facts or unmentioned tech.

## Layout

`packages/core` (engine, browser-safe, zero deps) · `packages/providers` (OpenAI-compatible SSE + Ollama keep_alive) · `packages/cli` (`pb`) · `packages/mcp-server` · `packages/playground` · `profiles/` (community templates — a PR adds a scenario) · `eval/` · `docs/ACCEPTANCE.md` (requirements → implementation → acceptance).

## Known limits

`pb watch` not built (D7 gate) · playground direct calls are subject to browser CORS (Ollama needs `OLLAMA_ORIGINS=*`) · rule 5 needs LLM-as-judge (M2) · 中文文档见 [README.md](README.md).

## License

Apache-2.0
