# 需求点 → 实现方案 → 验收标准

对应 PRD：`../prompt-boost-opensource-plan.md`（v1 修订版）。本文件是 M0 最小集（PRD §10）的实现映射与验收清单。

## 范围裁定

| PRD 内容 | 本版是否实现 | 依据 |
|---|---|---|
| core 引擎 + providers + 3 profiles + CLI + MCP server + playground + 中英 README（M0） | ✅ 实现 | PRD §10 最小集，拍板结论（§0.4/§11） |
| `pb eval` 确定性规则断言部分 | ✅ 提前实现为 `pb check` | PRD 附录「硬约束进 eval 断言」——规则与模板共用同一规格，是本版验收标准本身 |
| `pb watch` 快捷键常驻、浏览器插件、SDK 独立包、LLM-as-judge leaderboard | ❌ 不实现 | 决策记录 D7：链路验证（Spike-0）先于主形态编码；M1/M2 分期 |

## 需求映射

| # | 需求点（PRD 出处） | 实现方案 | 验收标准（证据） |
|---|---|---|---|
| R1 | 一键增强 + 流式回填（§3.2 MVP） | `core/enhance()`：单次 LLM 调用，`onDelta` 逐段回调；CLI/Playground/MCP 三端接入 | `packages/core/test/pipeline.test.js` · CLI e2e（`cli.test.js`） |
| R2 | 语言一致性最高优先级（§3.2） | 模板硬约束第 1 条（同语言输出、禁语言标签）+ 输出清洗 + 规则断言 `lang-consistency`（脚本级检测） | `rules.test.js`：中→英判 FAIL，同语判 PASS |
| R3 | 扩写而非回答（§3.2） | 模板硬约束「expand, do not answer」+ 规则断言 `expand-not-answer`（回答式开场白/以问句结尾判 FAIL） | `rules.test.js` |
| R4 | 原文安全 / 一键回退（§1.2） | API 返回 `{text, original, meta}` 三元组；Playground 保留原文 + Revert 按钮；CLI `--json` 含 original | `pipeline.test.js` · Playground UI |
| R5 | 结果清洗 + 结构化错误码（§1.2） | `clean.js`（去引号/围栏/长度钳制/空→`llm_error`）；错误码 `empty_input` / `provider_unavailable` / `llm_error` / `aborted` / `config_error` / `profile_not_found` | `clean.test.js` · `pipeline.test.js` · providers 非 200 → `provider_unavailable` |
| R6 | 取消即弃（§1.2 ADR-017 语义） | 全链路 `AbortSignal`；用户取消 → `aborted`，上游请求自然结束被丢弃 | `providers/test/openai.test.js`（流中断测试） |
| R7 | 场景 profiles ×3 + PR 即贡献（§3.2 V1） | `profiles/*.md`（frontmatter + 正文模板），`core/profile.js` 零依赖解析器；新增场景 = 新增 md 文件 | `profile.test.js` · `pb profiles` |
| R8 | 强度档位 polish/standard/expand（§3.2 V1） | 引擎注入 STRENGTH 段落到 system | `pipeline.test.js`（三种档位组装断言） |
| R9 | 模型路由：小快模型 + OpenAI 兼容 + Ollama 本地（§3.2/§5.2） | `providers/openai.js`（SSE 流式）+ `providers/ollama.js`（原生 `/api/chat`） | `providers/test/*.test.js`（对本地 mock 流服务） |
| R10 | **连接预热 + keep_alive 钉住模型**（§7.6-1，v1.1 合并项） | `provider.warmup()`：OpenAI 兼容端 GET /models 建 TLS 连接；Ollama 预载 + 每次请求携带 `keep_alive` | `ollama.test.js` 断言 keep_alive 参数直达服务端 |
| R11 | MCP tools 接入（§6 agent 自主调用） | `mcp-server`：stdio JSON-RPC 2.0，`enhance_prompt` tool（text/profile/strength/context） | `mcp.test.js`：initialize → tools/list → tools/call 全链路 |
| R12 | MCP prompts 接入（§6 用户显式触发 `/boost`） | 同 server 暴露 `boost-<profile>` prompts；**该模式把改写指令注入客户端自有模型，零 key 可用** | `mcp.test.js`：prompts/get 返回含 USER INPUT 的消息 |
| R13 | CLI 形态（§4 P0） | `pb`：一次性增强（参数/stdin）、`--json`、`profiles`、`check`、`doctor`；`pb watch` 明示被 D7 门控 | `cli.test.js` e2e |
| R14 | Web playground（§4 P0 转化漏斗） | 单文件 UI，BYOK 直连（key 只存 localStorage），流式 + 规则徽章 + Revert；零构建、零依赖静态服务 | 手动 + `serve.js` 可启动 |
| R15 | 性能预算（§5.3/§7.6） | 单次 POST、无中间件、模板精简、`max_tokens` 由 maxChars 推导；**不做结果缓存**（v1.1 缓存降级） | `bench.js`：引擎自身开销（组装+清洗）P50 < 5ms；TTFT 由 provider 决定并在 README 如实声明 |
| R16 | 验收标准即规则断言（附录） | `rules.js` 6 条确定性断言 = `pb check` = Playground 徽章 = `eval/run.mjs` 用例跑分 | `eval/run.mjs` 全 PASS |
| R17 | 隐私（§5.4） | BYOK、key 仅本地（env/config/localStorage）、遥测为零、依赖为零（无供应链面） | `package.json` 无 dependencies；代码无遥测调用 |

## 独立软件事实声明

- 本版不含 `pb watch`（D7 门控）：`pb watch` 会打印指向 PRD 决策记录的说明并退出。
- 引擎延迟基准只覆盖引擎自身开销；模型 TTFT 属于外部依赖，README 不做夸大承诺。
