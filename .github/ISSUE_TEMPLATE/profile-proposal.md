---
name: Profile proposal / 新场景模板提案
about: Propose a new scenario profile (the main contribution surface) / 提议新增场景 profile
labels: profiles
---

<!-- 这是本项目最重要的贡献入口，见 CONTRIBUTING.md 的「贡献分层」L1 -->

**场景与目标用户 / Scenario & audience**

<!-- 例如：sql / slide-deck / agent 任务拆解 …谁会在什么输入框里用它？ -->

**模板草稿 / Template draft**

<!-- 直接贴 profiles/<name>.md 的内容：frontmatter（name/domain/maxChars/noUnmentionedTech）+ 正文 -->

**评测用例 / Eval cases**

<!-- 至少 1 个正例（须通过全部规则断言）+ 1 个反例（须按预期失败在指定规则），将加入 eval/cases.json -->

**自测结果 / Self-check**

- [ ] `npm run eval` 全绿 / passes with my cases included
- [ ] 模板未与六条硬约束冲突 / template does not contradict the six hard constraints
