## ADDED Requirements

### Requirement: Agent 工具能力契约对齐（8 个工具）

The system SHALL expose 8 stable agent tools, with consistent behavior between the Python Agents service and the Node.js server:

- `list_strategies`
- `create_strategy`
- `delete_strategy`
- `query_triggers`
- `get_diagnostic`
- `update_subscription`
- `get_stock_info`
- `generate_report`

Each tool MUST:

- Use the same name and argument structure in:
  - Python `TOOLS_SPEC` (agents/config.py)
  - Node server tool execution (agent-routes.ts and related modules)
- Return a `ToolResult` object with `{ id, name, ok, result?, error? }`, where:
  - `id` matches the incoming call id
  - `name` matches the tool name
  - `ok` is `true` on success, `false` on failure
  - `result` is a JSON object compatible with `agents/tools.py` formatting logic
  - `error` is a human-readable error string when `ok` is `false`

#### Scenario: Agent 调用工具并成功执行

- **WHEN** the Python Agents service issues a `toolCalls` array that includes one or more of the 8 tools with valid arguments,
- **AND** the Node server executes them via its tool layer,
- **THEN** the Node server SHALL return a `toolResults` array where:
  - each tool call has a corresponding `ToolResult` with `ok: true` and a populated `result`,
  - the Python Agents service can use these results to generate a final natural-language reply.

#### Scenario: Agent 调用未知或未实现的工具

- **WHEN** the Python Agents service sends a `toolCalls` entry with a `name` that is not one of the 8 supported tools,
- **THEN** the Node server SHALL return a `ToolResult` with:
  - `ok: false`,
  - `error` describing `未知工具` or equivalent,
  - and SHALL NOT throw an uncaught exception.

### Requirement: 自然语言触发常见 Agent 场景

The system SHALL support driving the 8 tools via natural-language instructions through `/api/agent/chat`, at minimum for the following user scenarios:

- 策略管理：
  - "列出我的策略" → `list_strategies`
  - "帮我新增一个监控贵州茅台的策略" → `create_strategy`
  - "删除这条茅台的监控策略" → `delete_strategy`
- 触发与诊断：
  - "今天有哪些股票触发了异动？" → `query_triggers`
  - "看看贵州茅台最近的异动诊断" → `get_diagnostic`
- 订阅与推送：
  - "帮我绑定钉钉推送" → `update_subscription`
- 行情与报告：
  - "贵州茅台现在什么价格？" → `get_stock_info`
  - "生成本周监控报告" → `generate_report`

#### Scenario: 中文自然语言驱动工具调用

- **WHEN** a user sends a Chinese natural-language query via the frontend Agent chat (e.g., "今天有哪些股票触发了异动？"),
- **THEN** the Python Agents service SHALL either:
  - use LLM decision JSON, or
  - fall back to `heuristic_tool_calls`,
- to produce a `toolCalls` entry with the appropriate tool name and reasonable default arguments,
- AND the Node server SHALL execute the tool and return `toolResults` that can be turned into a human-readable reply.

### Requirement: 稳定的无 LLM 模式（LLM 未配置或调用失败）

The system SHALL degrade gracefully when the LLM is not configured or fails:

- Python Agents service detects missing `LLM_BASE_URL` / `LLM_API_KEY` or runtime errors and switches to "no-llm" mode.
- In "no-llm" mode:
  - `heuristic_tool_calls` MUST still be able to trigger a subset of tools (at least `list_strategies`, `create_strategy`, `query_triggers`),
  - `format_tool_results` MUST present the `toolResults` in a readable Chinese summary.

#### Scenario: LLM 未配置但用户请求策略列表

- **WHEN** the LLM is not configured,
- **AND** the user asks "列出策略" via Agent chat,
- **THEN** the system SHALL:
  - infer a `list_strategies` tool call via heuristics,
  - execute it on the Node server,
  - and return a textual summary of the strategy list using `format_tool_results`, without crashing.

