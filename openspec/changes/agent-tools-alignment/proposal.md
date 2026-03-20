## Why

当前 Python Agents 服务已经声明支持 8 个工具（`list_strategies`、`create_strategy`、`delete_strategy`、`query_triggers`、`get_diagnostic`、`update_subscription`、`get_stock_info`、`generate_report`），并在系统中扮演「自然语言编排层」的角色，用于把用户输入转换为对后端真实能力的调用。

但 Node.js 服务端目前仅实现了部分工具（`list_strategies` / `create_strategy`），其余工具尚未在服务端落地。这导致：

- Agent 在决策时经常产生「不存在的工具调用」，用户会感知为“AI 听不懂/做不到”；
- Python 与 Node 之间的能力契约不一致，调试困难、行为不可预期；
- OpenSpec 中关于策略管理、触发日志、订阅推送等能力的文档与实际 Agent 能力脱节。

因此，需要一个专门的变更来对齐 Agent 工具与系统能力，让「文档、服务端实现、Agent 决策」三者闭环。

## What Changes

- 在 Node.js `server` 端补齐并接入 8 个 Agent 工具：
  - `list_strategies`
  - `create_strategy`
  - `delete_strategy`
  - `query_triggers`
  - `get_diagnostic`
  - `update_subscription`
  - `get_stock_info`
  - `generate_report`
- 确保每个工具：
  - 参数结构与 `agents/config.py` 中的 `TOOLS_SPEC` 严格对齐；
  - 内部实现复用现有的 REST API / DB 能力（策略、订阅、触发日志、行情查询等）；
  - 返回结果兼容 `agents/tools.py` 的格式化逻辑，便于在「无 LLM」模式下也能输出可读结果。
- 在 Python Agents 侧：
  - 修正 `heuristic_tool_calls` 等兜底逻辑的类型与参数结构，使其与工具规范一致；
  - 适度补充「删除策略 / 查询触发 / 订阅管理 / 行情查询 / 报告生成」等意图的规则触发词；
  - 避免在未真正配置 PostgreSQL 时误入 PG 模式，稳定会话记忆行为。

## Capabilities

### New / Refined Capabilities

- `agent-orchestration`：Agent 作为「自然语言编排层」，可以围绕以下典型场景稳定工作：
  - 自然语言创建/查询/删除策略（映射到策略管理能力）；
  - 通过中文问题查询触发记录、获取单只股票的诊断说明（映射到触发日志与诊断能力）；
  - 通过 Agent 绑定或更新钉钉/企微等订阅渠道（映射到订阅推送能力）；
  - 查询单只或多只股票的当前价格/涨跌幅等信息（映射到行情查询能力）；
  - 生成按日/周/月维度的监控报告（映射到统计与报告能力）。

### Impact

- 用户可以通过前端 Agent 浮窗，以中文自然语言稳定完成策略管理、触发查询、订阅管理等高频操作，而不用频繁切换到表单界面。
- 开发和运维可以依赖「8 个工具」作为稳定的能力契约，在此之上演进 Agent 的提示词、推理策略或 LLM 模型，而无需反复修改后端接口。
- 为后续扩展（新增工具、重构工具参数、增加更多统计与报告能力）提供清晰的文档与实现边界。

