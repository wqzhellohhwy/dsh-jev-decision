# dsh-jev-decision

把基元律动的 **JEV 决策模型**（`NeoHorse-Jev-4B`）接成三个 DSH 工具。

决策模型不是对话模型 —— 它输入一段 `state`（背景）加若干题目，输出概率、选项或评分，走 `/v1/decision` 专用接口，不能当聊天模型用。

## 三个工具

| 工具 | 用途 | 返回 |
|---|---|---|
| `jev_noul` | 判断题：某事成不成立 | 成立概率 `p`（0~1 软概率，非布尔） |
| `jev_choice` | 多选一：方案权衡、分类归因 | 选中项 `pick` + 各选项概率 |
| `jev_score` | 按等级量表打分 | 概率加权期望档位 `score` + `legend` + 各档概率 |

三者都支持一次传 1~16 题，一次请求批量算完（比逐条调用划算得多）。

## 怎么用

直接让 agent 调用，例如：

> 用 jev_choice 判断：线上 CPU 100%，优先加缓存还是查索引？

`state` 应写成**聚焦的判断背景**，不要贴长对话历史——越长越不准，且输入超过约 8192 token 会被拒。

## 可靠性（实测 8 道客观题命中 7/8 = 87.5%）

| 概率区间 | 实测表现 | 建议 |
|---|---|---|
| `p ≥ 0.90` | 3/3 正确 | 可采信 |
| `0.75 ≤ p < 0.90` | 2/2 正确 | 采信但留意 |
| `0.35 ≤ p < 0.75` | 1/2 正确 | **低置信，必须复核** |

JEV 适合作**初筛、排序、打标签**，不适合作为唯一裁决依据。同输入重复跑结果完全一致（零随机性）。

## 配置

```yaml
- id: dsh-jev-decision
  name: '@local/dsh-jev-decision'
  config:
    baseURL: https://tokenrhythm.studio/v1   # 默认值
    apiKeyRef: TOKENRHYTHM_API_KEY           # 默认值，从凭据库解析
    timeoutMs: 10000                         # 默认值
    maxQuestions: 16                         # 默认值
```

密钥从 DSH 凭据库按 `apiKeyRef` 解析，**不读明文文件**。改 key 无需重启。

## 限制（实测）

- 单次 1~16 题，17 题拒绝
- 输入 token ≈8192 上限
- 请求体 ≤1 MiB
- 限流：60 秒滚动窗口 30 次
- 请求体是**严格白名单**：只发 `model`/`state`/`questions`/`image`，插件已按此构造

## 错误码

| HTTP | code | 含义 |
|---|---|---|
| 401 | `UNAUTHORIZED` | 密钥无效 |
| 403 | — | 账号不在灰度名单 |
| 413 | `REQUEST_BODY_TOO_LARGE` | 请求体超 1MiB |
| 422 | `JEV_INVALID_REQUEST` | 参数不合法（客户端问题，重试无意义） |
| 422 | `JEV_UPSTREAM_REJECTED` | 输入太长（token 超限） |
| 429 | `RATE_LIMITED` | 限流，按 `retryAfterSeconds` 退避 |

错误信息里会带上 `traceId`，便于向平台排查。

## 未实现

- 图片输入（`image` 顶层字段，仅限 1 题）：有需求再加
- 未接成 LLM provider：决策模型没有消息结构，无法映射为对话

## 实现要点（改代码前必读）

DSH 0.2.0-rc.2 的 `ctx.tools.register` 行为：

| 项 | 行为 | 要求 |
|---|---|---|
| `parameters` | **不做编译，原样发给模型** | 必须是完整 JSON Schema：顶层 `type:'object'` + `properties` + `required` 数组 |
| `output.schema` | 跑 `assertSupportedJsonSchema` | 同上，且嵌套 object 必须显式 `additionalProperties: false` |

- 不能用 `defineTool` 的 spec 格式（`{ state: { type, required: true } }`）—— 那会让模型收到 `type: null`。
- 不要 import `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-credentials`：本地插件目录的 node_modules 链里没有这两个包。`ToolDefinition` 直接用裸对象；凭据直接用 `ctx.credentials.resolve('TOKENRHYTHM_API_KEY')` 传字符串。
- DSH schema 子集不支持 `additionalProperties` 为对象 ⇒ 键值对输出改用 `[{label, p}]` 数组。
- 自检脚本：`assertSupportedJsonSchema(parameters)` 与 `assertSupportedJsonSchema(output.schema)` 必须都通过。
