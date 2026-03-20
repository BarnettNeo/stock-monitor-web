## 1. 配置与环境稳定性

- [ ] 1.1 审查 `.env` 中与 Agents 相关的配置，移除示例密钥或迁移到 `.env.example`。
- [ ] 1.2 调整 Python `memory` 的 PostgreSQL 启用逻辑（例如增加显式开关），避免在仅设置 `DB_HOST` 时误入 PG 模式。

## 2. Node 工具实现与对齐

- [ ] 2.1 在 `server` 侧实现缺失的 6 个工具（可集中在一个工具模块或 `agent-routes.ts` 附近）：
  - [x] 2.1.1 `delete_strategy`：按 `strategyId` 为主键删除策略，校验当前用户权限。
  - [x] 2.1.2 `query_triggers`：复用触发日志查询逻辑，支持 `dateRange/symbols/limit`。
  - [x] 2.1.3 `get_diagnostic`：基于触发日志聚合某股票最近诊断信息。
  - [x] 2.1.4 `update_subscription`：复用订阅路由创建/更新订阅（dingtalk/wechat/email）。
  - [x] 2.1.5 `get_stock_info`：复用行情接口查询一只或多只股票的价格/涨跌幅。
  - [x] 2.1.6 `generate_report`：按日/周/月聚合策略与触发统计并返回摘要。
 - [x] 2.2 在 `executeToolCall()` 中接入全部 8 个工具，统一 `ToolResult` 结构与错误封装。

## 3. Python Agents 契约对齐

- [x] 3.1 审查并更新 `agents/config.py` 中的 `TOOLS_SPEC`，确保参数含义与 Node 工具实现完全一致。
- [x] 3.2 修正 `agents/llm.py` 中 `heuristic_tool_calls` 的返回类型与参数构造（特别是 `delete_strategy` 的参数形态）。
  - [x] 3.3 视需要为 `delete_strategy/query_triggers/get_diagnostic/update_subscription/get_stock_info/generate_report` 补充合理的中文触发关键词。

## 4. 端到端验证

- [x] 4.1 为每个工具准备至少一个端到端验证用例（从 `/api/agent/chat` 输入到自然语言输出），已用手动/脚本方式完成主要链路验证。
- [ ] 4.2 在前端 `AgentChatFloat.vue` 中，保证当工具执行失败或 Agents 服务不可用时，以系统消息清晰提示用户。
- [ ] 4.3 更新项目文档（README 或相关章节），简要列出当前 Agent 支持的 8 个能力及示例语句。

