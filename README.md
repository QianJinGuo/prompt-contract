# ✨ PromptBoost

[![CI](https://github.com/QianJinGuo/prompt-boost/actions/workflows/ci.yml/badge.svg)](https://github.com/QianJinGuo/prompt-boost/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

**开源的「一键 Prompt 增强」引擎：在任何你输入 AI 的地方，把模糊想法变成结构化任务规范。**

灵感来自 WorkBuddy 的 Boost Prompt（功能逆向分析见仓库外 `prompt-boost-opensource-plan.md`），但定位相反：WorkBuddy 把该能力绑定在自己的 IDE 里，PromptBoost 把它做成**开放引擎 + 多端薄壳**——CLI、MCP server、浏览器 Playground 共用同一个零依赖内核。

> 当前版本：M0 最小集。`pb watch`（全局热键常驻）按决策记录 D7 门控：取词/回贴链路通过 Spike-0 验证后才实现。

---

## 30 秒上手

零依赖（Node ≥ 20，无需 `npm install`）：

```bash
# 1) 用本地 mock 上游立刻体验完整链路（无 key、无网络）
node mock/server.js &

# 2) CLI 一键增强
node packages/cli/bin/pb.js "帮我做一个展示我家狗的网站" \
  --provider openai --base-url http://127.0.0.1:8787/v1 --api-key test-key-123 --model mock-model
# → 输出结构化任务规范，stderr 显示 profile/模型/耗时/字符数

# 3) Playground（浏览器，BYOK 直连）
node packages/playground/serve.js   # → http://127.0.0.1:8123/
```

## 接入你的真实模型

```bash
# OpenAI 兼容（OpenAI / DeepSeek / Qwen / GLM / OpenRouter / vLLM …）
export PB_API_KEY=sk-xxx
export PB_MODEL=gpt-4o-mini            # 增强任务轻，小快模型即可（PRD §3.2 模型路由）
pb "A website for my dog"

# 本地 Ollama（断网可用；keep_alive 把模型钉在内存，热路径零冷启动）
export PB_PROVIDER=ollama
export PB_MODEL=qwen3:4b
pb "帮我写一封请假邮件"

# 或写进配置一次，处处生效
mkdir -p ~/.prompt-boost && cat > ~/.prompt-boost/config.json <<'EOF'
{ "provider": "openai", "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-xxx", "model": "gpt-4o-mini" }
EOF
```

## 接入 agent 工具（MCP）

```json
{ "mcpServers": { "prompt-boost": { "command": "node", "args": ["/绝对路径/packages/mcp-server/bin/prompt-boost-mcp.js"] } } }
```

- **tool 模式**：agent 收到模糊任务时自主调用 `enhance_prompt(text, profile?, strength?, context?)`，服务端用你配置的模型完成增强；
- **prompt 模式**（零 key）：客户端里出现 `/boost-coding-agent` 等斜杠命令，把改写规范注入**客户端自有模型**，不需要任何 API key。

## 验收与质量

```bash
npm test        # 43 项：引擎单测 + SSE/ndjson 流式 + CLI/MCP 端到端（对本地 mock）
npm run eval    # 9 个确定性用例：6 条硬约束规则断言（正例全过 / 反例必败）
npm run bench   # 引擎自身开销基准：P50 0.004ms（预算 <5ms）
```

**性能的诚实声明**：引擎自身开销微秒级（见 bench）；端到端时延的大头是模型 TTFT，由你选择的模型决定——这也是我们把「默认路由小快模型」列为第一延迟决策的原因（PRD §7.6）。快捷键回贴场景的目标是总时长 P95 ≤ 2–3s。

## 六条硬约束（模板与评测共用同一份规格）

1. 语言一致性最高优先级，禁输出语言标签；2. 只输出增强文本（无解释/围栏/引号）；3. ≤800 字符、无悬空列表；4. 扩写而非回答；5. 原文清晰时仅轻润色；6. 不添加未提及的技术栈与事实。
前 1/2/3/4/6 条为确定性断言（`pb check`、Playground 徽章、`npm run eval`），第 5 条留待 LLM-as-judge（M2）。

## 目录结构

```
packages/core          引擎：profile 解析 / 消息组装 / 清洗 / 错误码 / 规则断言（零依赖，浏览器安全）
packages/providers     OpenAI 兼容 SSE + Ollama（keep_alive 钉模型 + warmup 预热）
packages/cli           pb：增强 / profiles / check / doctor
packages/mcp-server    MCP：enhance_prompt tool + boost-* prompts（stdio JSON-RPC）
packages/playground    单文件 UI：BYOK、流式、规则徽章、Revert
profiles/              场景模板（Markdown + frontmatter，提交 PR 即新增场景）
eval/                  确定性用例集
mock/                  本地双协议 mock 上游（测试与演示共用）
docs/ACCEPTANCE.md     需求 → 实现 → 验收标准映射
```

## 贡献模板 = 贡献场景

新增一个 `profiles/<name>.md`（frontmatter：`name` / `domain` / `maxChars` / `noUnmentionedTech`，正文为该场景的改写角色说明），配上 `eval/cases.json` 里的正反用例，就是一个完整的新场景贡献。

## 已知边界（诚实清单）

- `pb watch` 未实现（D7 门控，`pb watch` 会指向 PRD 决策记录）；
- Playground 直连受浏览器 CORS 限制：Ollama 需 `OLLAMA_ORIGINS=*`，部分云厂商需自备代理；
- 确定性规则无法覆盖「润色是否足够克制」这类语义判断（M2 引入 LLM-as-judge）；
- 英文 README 见 [README.en.md](README.en.md)。

## License

Apache-2.0
