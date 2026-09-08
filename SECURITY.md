# Security Policy / 安全策略

## Supported versions / 支持版本

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability / 报告漏洞

请使用 GitHub 的 **Private vulnerability reporting**（仓库 Security 标签页 → Report a vulnerability）私下报告，不要开公开 issue。 / Please report vulnerabilities privately via GitHub's Security tab rather than a public issue. 通常 72 小时内回应。 / Expect a response within 72 hours.

## 安全模型（请先读这一段）/ Security model

PromptContract 的设计把攻击面压到最小，使用前请了解以下事实：

1. **密钥**：API key 只存在于你的环境变量、`~/.prompt-contract/config.json` 或浏览器 localStorage（Playground）。本项目无服务端、无遥测，代码中不存在任何上传密钥的路径；`requests` 中出现 key 即为 bug，请报告。
2. **Prompt 内容**：由你配置的 provider（云端或本地 Ollama）处理，去向与你的 API 调用一致；本项目不中转、不存储。
3. **信任边界**：MCP server 与 CLI 与任何处理不可信输入的 LLM 工具一样，增强结果在进入其他系统前应经过人工确认（Playground 的规则徽章与 `prompt-contract check` 就是为此提供的第一道确定性检查）。
4. **供应链**：运行时依赖为零（`package.json` 无 dependencies），依赖投毒面被消除；CI 直接跑标准库测试。

## 已知边界 / Known limitations

- Playground 浏览器直连第三方端点受 CORS 限制，属预期行为而非漏洞；
- 确定性规则断言不能防御语义层面的提示注入（如模型输出的隐性指令），M2 的 LLM-as-judge 评测与人工确认流程是当前对策。
