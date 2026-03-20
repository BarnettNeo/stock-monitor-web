## Context

在现有架构中：

- **后端 server**（Node.js + Express + TypeScript）已经提供了策略管理、订阅管理、触发日志、行情查询等 REST API 能力，并通过 SQLite/sql.js 完成数据持久化与定时扫描。
- **Python Agents 服务**负责：
  - 调用 OpenAI 兼容接口（当前为通义千问 Qwen3-Max）进行意图识别与工具选择；
  - 通过 `toolCalls` 协议请求执行具体工具，并在拿到 `toolResults` 后生成最终自然语言回复；
  - 维护会话记忆与多轮策略创建流程。
- **Node `agent-routes.ts`** 充当「编排网关」：
  - 对外暴露 `/api/agent/chat`；
  - 对内与 Python `/agent/chat` 通信，并负责执行工具。

本设计的目标是：让这三层对齐在一组稳定的「Agent 工具契约」之上。

## Responsibilities

### Python Agents 服务

- 负责「理解用户意图 + 决定是否调用工具 + 组织多轮对话」，不直接操作数据库；
- 依赖一组抽象工具定义（`TOOLS_SPEC`）：
  - 工具名称：`list_strategies` / `create_strategy` / `delete_strategy` / `query_triggers` / `get_diagnostic` / `update_subscription` / `get_stock_info` / `generate_report`；
  - 参数结构：对齐 OpenSpec 与 Node 服务端的业务含义；
  - 工具结果：被视为「黑盒 JSON」，主要由 Node 保证格式。
- 通过 LLM（含 JSON 模式）与规则兜底（`heuristic_tool_calls`）来构造 `toolCalls`，再把执行结果整合成用户可读回复。

### Node server（Agent Gateway + Tools）

- 负责「工具的真实执行」：
  - 校验当前登录用户（`requireAuth`）并按 userId 约束可操作的数据范围；
  - 复用已有 REST 逻辑或底层 DB API 实现业务；
  - 把执行结果封装成 `ToolResult` 结构返回给 Python Agents。
- 工具实现策略：
  - 优先直接调用现有路由（如 `strategies-routes.ts`、`subscriptions-routes.ts`、`trigger-logs-routes.ts` 等），避免重复业务逻辑；
  - 在必要时直接访问 DB（如简化的统计/报告），但保持与已有 API 行为一致；
  - 对所有错误做统一封装（`ok: false, error: string`），避免抛出未捕获异常。

### 前端 Agent 浮窗

- 只感知一个统一的 `/api/agent/chat` 接口；
- 不关心工具调用细节，只展示最终自然语言回复与必要的系统提示。

## Tool Contract Design

每个工具都遵循统一契约：

- 请求：
  - `name`: 工具名称（字符串，必须是 TOOLS_SPEC 中定义的值）；
  - `arguments`: 参数对象（字段名与类型在 Agent 与 Node 之间一致）；
  - `id`: 调用 ID（由 Agent 生成，Node 原样返回）。
- 响应：
  - `ok`: 布尔值，表示执行是否成功；
  - `result`: 成功结果的 JSON（结构由 Node 定义，并与 `agents/tools.py` 中的渲染逻辑兼容）；
  - `error`: 出错时的错误信息（面向 Agent，而不是用户）。

### 典型工具行为（示例）

- `list_strategies`
  - 输入：`{ name?: string, enabledOnly?: boolean, limit?: number }`
  - 行为：按当前用户过滤策略记录，并返回精简列表（id/name/symbols/enabled/alertMode 等）。
- `create_strategy`
  - 输入：包含策略名、股票代码、阈值/目标价、扫描间隔、冷却时间、指标/形态开关、订阅 ID 等；
  - 行为：创建策略并触发 DB 落盘，返回 id / name / symbols 等关键字段。
- `delete_strategy`
  - 输入：优先使用 `strategyId`；必要时可接受 `symbols` 或 `name` 作为辅助匹配，但需避免误删；
  - 行为：删除当前用户可见的指定策略，返回被删除策略的摘要信息。
- `query_triggers`
  - 输入：`{ dateRange?: "today"|"week"|"month", symbols?: string|string[], limit?: number }`
  - 行为：基于触发日志表按时间/股票筛选记录，返回精简触发列表。
- `get_diagnostic`
  - 输入：`{ symbol: string, timeRange?: "1d"|"3d"|"7d" }`
  - 行为：围绕单只股票聚合最近触发记录，给出结构化诊断摘要（例如触发次数、主因类型分布等）。
- `update_subscription`
  - 输入：`{ type: "dingtalk"|"wechat"|"email", endpoint?: string, secret?: string, enabled?: boolean }`
  - 行为：为当前用户创建或更新一个订阅配置，返回订阅类型/状态等信息。
- `get_stock_info`
  - 输入：`{ symbols: string|string[], fields?: string[] }`
  - 行为：查询行情接口，按股票输出价格、涨跌幅等字段。
- `generate_report`
  - 输入：`{ reportType: "daily"|"weekly"|"monthly", dateRange?: string, format?: "text"|"json"|"html" }`
  - 行为：按时间窗口聚合策略数量、触发次数、热门股票等指标，并返回报告摘要。

## Error Handling & Observability

- Node 侧：
  - 所有工具内部错误要被捕获并转换为 `ok: false, error: string`；
  - 建议在日志中记录：工具名、用户 ID、耗时、主要参数、错误栈（不暴露给前端）。
- Python 侧：
  - 在 LLM 不可用或调用失败时，优先通过 `format_tool_results` 把工具结果以纯文本形式呈现；
  - 对未知工具名或参数不匹配的情况，返回清晰的提示，而不是静默失败。

## Future Extensions

- 在此契约之上，可以：
  - 引入更多工具（例如导出 CSV、批量启用/停用策略等），只要遵守同一调用协议；
  - 重构工具内部实现（例如迁移到 PostgreSQL），而不影响 Agent 层逻辑；
  - 对不同用户/环境施加不同的工具白名单或配额策略。

