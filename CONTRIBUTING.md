# 贡献指南 / Contributing

Thanks for your interest in PromptBoost! 谢谢你愿意贡献。这个项目最重要的贡献面是**场景 profile**——为新的使用场景编写模板并附上评测用例，就是一次完整且高价值的贡献。

## 快速开始 / Quick start

```bash
git clone https://github.com/QianJinGuo/prompt-boost && cd prompt-boost
node --test packages/core/test/*.test.js packages/providers/test/*.test.js packages/cli/test/*.test.js packages/mcp-server/test/*.test.js   # 43 tests, no npm install needed
npm run eval     # 9 deterministic cases
npm run bench    # engine overhead budget (P50 < 5ms)
```

要求 / Requirements: Node ≥ 20。项目零运行时依赖——请勿在 `package.json` 中引入 dependencies；标准库能做的事不要引入包。

## 贡献分层 / Contribution ladder

| 层级 | 内容 | 入口 |
|---|---|---|
| L0 | 修复文案、补充用例、翻译 | 直接 PR |
| L1 | **新增场景 profile**（`profiles/<name>.md` + `eval/cases.json` 正反用例） | 先开 `profile-proposal` issue |
| L2 | 新 provider（如 Anthropic 原生）、新端适配（SDK/插件）、核心引擎改动 | 先开 issue 讨论再动手 |

## 新增一个场景 profile（最常见贡献）

1. 复制 `profiles/writing.md` 为你的 `profiles/<name>.md`，frontmatter 只含 `name` / `domain` / `maxChars` / `noUnmentionedTech`，正文是该场景的改写角色说明；
2. 在 `eval/cases.json` 增加至少 1 个正例（必须通过全部规则断言）和 1 个反例（必须按预期失败在指定规则上）；
3. `npm run eval` 全绿后提交 PR。

**规则即规格**：profile 的行为边界由六条硬约束保证（语言一致性、只输出增强文本、长度、扩写非回答、无幻觉技术栈），模板与评测共用同一份规格——不要在 profile 正文里写入与硬约束冲突的要求。

## 提交规范 / Commit style

Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` / `profiles:`）。CI 会在 ubuntu/macos × Node 20/22 矩阵上跑测试、eval 与性能预算，全绿是合并前提。

## 行为准则

参与本项目即表示你同意 [Contributor Covenant](CODE_OF_CONDUCT.md)。
