# CHANGELOG

## 0.1.1 — 2026-10-19 10:45

修复三个工具的 schema 被模型拒绝。

- **根因**：`ctx.tools.register` 对 `parameters` 不做编译，**原样发给模型**。此前按 `defineTool` 的 spec 格式（`{ state: {type, required:true}, ... }`）书写，导致顶层缺 `type:'object'`，模型收到 `type: null` ⇒ `INVALID_REQUEST: Invalid schema for function 'jev_choice'`。
- **修法**：`parameters` 改用完整 JSON Schema（顶层 `type:'object'` + `properties` + `required` 数组）；嵌套 object 一律显式 `additionalProperties: false`。
- `output.schema` 同样改为完整 JSON Schema（`register` 会对它跑 `assertSupportedJsonSchema`）。
- 去掉对 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-credentials` 的 import（本地插件目录解析不到这两个包）：
  - `defineTool` → 直接给 `ToolDefinition` 裸对象
  - `credentialRef` → 直接把 `apiKeyRef` 字符串传给 `ctx.credentials.resolve`
- 输出字段 `p`（对象）改为 `probs`（`[{label, p}]` 数组）：DSH 子集不支持 `additionalProperties` 为 schema。
- 三个工具实测通过（真实模型调用）：`jev_noul` p=0.987 / `jev_choice` pick=加缓存 p=0.865 / `jev_score` score=2.00 改完但没验证。

## 0.1.0 — 2026-10-19 10:20

首版。

- 新增 `jev_noul` / `jev_choice` / `jev_score` 三个工具，接基元律动 JEV 决策模型 `NeoHorse-Jev-4B`。
- 端点 `POST {baseURL}/decision`，鉴权走 DSH 凭据库 `TOKENRHYTHM_API_KEY`。
- 请求体严格白名单：仅 `model`/`state`/`questions`/`image`，多一字段即 422。
- 每题必须带 `type`（`noul`/`choice`/`score`）；`noul` 禁带 criteria；`choice` criteria 非空；`score` criteria 2~10 档。
- 本地预校验题数（≤`maxQuestions`，默认 16）、题目 id 非空与不重复、instructions 非空、选项名不重复、档位数合法。
- 错误映射：401/403/413/422(两子码)/429，信息带 `traceId`，429 提示 `retryAfterSeconds`。
- 超时默认 10s（实测最坏 5.6s 出现在限流排队，非推理慢）。
- 未实现图片输入与 provider 形态接入。
