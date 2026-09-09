# ✨ PromptContract

[![CI](https://github.com/QianJinGuo/prompt-contract/actions/workflows/ci.yml/badge.svg)](https://github.com/QianJinGuo/prompt-contract/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

[English](README.md) · 简体中文

![PromptContract——模糊的一句话被编译成结构化任务规范（目标 / 范围 / 验收标准 / 明确不做的事），六条硬规则经 `prompt-contract check` 校验。真实 LLM 端到端 P50 2.3s，引擎附加开销 0.005ms。CLI · MCP · Playground——零依赖、BYOK、可离线。](docs/assets/hero-cover.png)

**PromptContract 是面向 AI 编码 agent 的确定性 prompt 契约层**：把模糊的一句话编译成结构化任务规范（目标 / 范围 / 约束 / 验收标准），并在你看到结果之前用六条硬规则完成校验。

它不是「更聪明的大脑」：思考由你的模型完成，PromptContract 让 agent 的输入变得稳定、可审查、可跨模型与跨工具迁移。

## 为什么

- **稳定的 agent 输入**——profile + 硬约束把「帮我做个网站」编译成目标 / 范围 / 验收标准 / 明确不做的事；重试与范围漂移是否减少，仍须由任务级 harness 验证，当前不作产品结论
- **六条确定性护栏**——语言一致性、只输出增强文本、长度与完整性、扩写而非回答、无幻觉技术栈；`prompt-contract check` 随时可断言，模板与测试共用同一份规格
- **一个引擎、三个形态**——CLI、MCP server（agent 调用的 tool + 用户调用的斜杠 prompts）、浏览器 Playground，共享同一个零依赖内核
- **隐私即架构**——BYOK、无中间服务、零遥测，Ollama 全本地可用

## 30 秒上手（无需 API key）

```bash
git clone https://github.com/QianJinGuo/prompt-contract && cd prompt-contract
node mock/server.js &                                   # 本地 mock 上游
node packages/cli/bin/contract.js "帮我做一个展示我家狗的网站" \
  --provider openai --base-url http://127.0.0.1:8787/v1 --api-key test-key-123 --model mock-model
node packages/playground/serve.js                       # → http://127.0.0.1:8123/（?demo=1 为自运行演示）
```

安装：`npm i -g prompt-contract`；或零安装体验：`npx prompt-contract "你的模糊想法"`。

在线 Playground：**[qianjinguo.github.io/prompt-contract](https://qianjinguo.github.io/prompt-contract/)**（BYOK——key 只留在你的浏览器本地；端点需允许 CORS）。

## 接入真实模型

```bash
export CONTRACT_API_KEY=sk-xxx CONTRACT_MODEL=gpt-4o-mini   # 任意 OpenAI 兼容端点（vLLM、OpenRouter、自家网关…）
prompt-contract "A website for my dog"

export CONTRACT_PROVIDER=deepseek CONTRACT_API_KEY=sk-…     # 厂商预设：自带 base URL 与建议默认模型
export CONTRACT_PROVIDER=qwen                                # 另有 glm、moonshot、groq、openrouter、lmstudio（免 key）
export CONTRACT_PROVIDER=anthropic CONTRACT_API_KEY=sk-ant-… # Anthropic 原生 Messages API——思考增量在传输层即被丢弃
prompt-contract "帮我写一封请假邮件"

export CONTRACT_PROVIDER=ollama CONTRACT_MODEL=qwen3:4b     # 全本地；keep_alive 把模型钉在内存
prompt-contract "帮我写一封请假邮件"
```

或一次写入 `~/.prompt-contract/config.json`。

## MCP 接入

| 模式 | 调用方 | 需要 key？ |
|---|---|---|
| **Tool** `enhance_prompt(text, profile?, strength?, context?)` | agent 在执行模糊任务前自行调用 | 需要（走你配置的 provider） |
| **Prompts** `/contract-coding-agent` 等 | 你手动调用；改写规范注入**客户端自有模型** | **不需要——服务器可在零配置下启动** |

## 质量门禁与诚实边界

```bash
npm test        # 102 项（串行）：引擎单测 + SSE/ndjson 流式 + CLI/MCP 端到端（对本地 mock）
npm run eval    # 9 个确定性用例（六条硬约束断言）
npm run eval:tasks -- --format-only  # 校验 coding-agent 任务 fixture 的格式门禁
npm run bench   # 引擎自身开销 P50 ≈ 0.005ms（预算 <5ms）
```

**这些证明的是管线正确与格式合规，不证明「增强后的 prompt 提升了下游任务效果」**。任务级 harness 与 fixture 见 [docs/TASK-EVAL.md](docs/TASK-EVAL.md)，但仓库尚未包含下游任务结果，因此不作有效性结论。

## 状态与路线图（诚实版）

- **已交付**：引擎、CLI（含 `prompt-contract spike-0`、`prompt-contract watch` 常驻模式）、MCP server（tool + 零 key prompts）、Playground、3 个 profiles、eval 用例、CI 矩阵
- **常驻模式**：`prompt-contract watch`——在 macOS 任意应用选中一段粗糙 prompt，按 ⌥B，增强结果原地替换选区：剪贴板先备份后恢复、回贴前焦点复验（漂移即放弃）、以 `prompt-contract spike-0` 证据为启动门控（决策 D7）；详见 [docs/WATCH.md](docs/WATCH.md)。`prompt-contract spike-0` 本身仍是 dry-run 诊断，永不发送粘贴；见 [docs/SPIKE-0.md](docs/SPIKE-0.md)
- **开放验证**：任务级效果评测的 harness 与任务 fixture 已交付，但还没有声明 runner 产生并复核结果；长期价值在此之前仍是假设
- **推迟**：动画 demo 资产、IDE 插件、LLM-as-judge（作为任务级评测中的评分器之一）

## 贡献与许可

[CONTRIBUTING.md](CONTRIBUTING.md)（新增 profile = 新增场景，PR 即贡献）· [行为准则](CODE_OF_CONDUCT.md) · [安全策略](SECURITY.md) · Apache-2.0
