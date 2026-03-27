# Subscription Management 回归样例

## 使用说明
- 目标: 回归验证 `subscription_management` skill 的意图识别、目标定位、权限控制和字段更新完整性。
- 执行方式: 在前端或直接调用 `POST /api/agent/chat`，逐条发送“用户输入”。
- 判定方式: 对照“预期行为”和“关键断言”检查结果。

---

## A. 普通用户场景

### A1. 查询自己的订阅列表
- 角色: `user`
- 用户输入: `列出我的订阅`
- 预期行为: 触发 `list`，调用 `GET /api/subscriptions`，skill 侧仅展示当前用户订阅。
- 关键断言:
  - 返回中不应出现其他用户订阅。
  - 每条记录包含名称、状态、类型、ID（可包含创建人字段但应是自己）。

### A2. 查看订阅详情（按名称定位）
- 角色: `user`
- 用户输入: `查看“钉钉交易提醒”订阅详情`
- 预期行为: 触发 `get`，根据名称定位目标；若唯一命中则调用 `GET /api/subscriptions/:id`。
- 关键断言:
  - 返回字段包含 `name/type/enabled/webhookUrl/keyword`。

### A3. 启用/停用订阅（单字段更新）
- 角色: `user`
- 用户输入: `把“钉钉交易提醒”停用`
- 预期行为: 触发 `update`，patch 至少包含 `enabled=false`，调用 `PUT /api/subscriptions/:id`。
- 关键断言:
  - 更新后状态显示为停用。
  - 不要求用户手动输入全量字段（skill 自动补齐当前字段）。

### A4. 修改订阅 webhook（口语化）
- 角色: `user`
- 用户输入: `把“钉钉交易提醒”的 webhook 改成 https://example.com/webhook`
- 预期行为: 触发 `update`，patch 至少包含 `webhookUrl=...`，调用 `PUT /api/subscriptions/:id`。
- 关键断言:
  - `PUT` 成功且 webhook 生效。

### A5. 创建订阅（缺参追问）
- 角色: `user`
- 用户输入: `帮我新建一个钉钉订阅`
- 预期行为: 触发 `create`，进入 `create_missing`，追问缺少字段（通常为 `name` 或 `webhookUrl`）。
- 关键断言:
  - 追问应聚焦 1~2 个关键问题，不应一次问过多。
  - 用户补齐后调用 `POST /api/subscriptions`，并返回新订阅 `id`。

### A6. 创建企微应用订阅（wecom_app 缺参追问）
- 角色: `user`
- 用户输入: `帮我新建一个企微应用订阅`
- 预期行为: 触发 `create`，进入 `create_missing`，追问 `name` 以及 `wecomApp.corpId/corpSecret/agentId` 等关键字段（分 1~2 次追问完成）。
- 关键断言:
  - 未补齐 wecomApp 必填字段前，不应直接调用 `POST /api/subscriptions`。
  - 补齐后 `POST` 成功并返回新订阅 `id`。

### A7. 修改企微应用订阅字段（wecomApp 合并更新）
- 角色: `user`
- 用户输入: `把“企微应用提醒”的 toUser 改成 @all，agentId 改成 1000002`
- 预期行为: 触发 `update`，patch 包含 `wecomApp.toUser`/`wecomApp.agentId`，调用 `PUT /api/subscriptions/:id`，skill 自动与当前配置合并后发送。
- 关键断言:
  - `PUT` 成功，且不会把未提及的 wecomApp 字段清空。

### A8. 越权保护（普通用户尝试改归属 userId）
- 角色: `user`
- 用户输入: `把“钉钉交易提醒”归属到用户ID 11111111-1111-1111-1111-111111111111`
- 预期行为: skill 拒绝或丢弃 `userId` 更新（不允许普通用户改归属）。
- 关键断言:
  - 不应发送包含目标 `userId` 的 `PUT` 请求体（或返回明确 forbidden 提示）。
  - 不发生越权修改。

### A9. 删除订阅
- 角色: `user`
- 用户输入: `删除“钉钉交易提醒”`
- 预期行为: 触发 `delete`，若唯一命中则调用 `DELETE /api/subscriptions/:id`。
- 关键断言:
  - 删除成功返回确认文案。

---

## B. 管理员场景

### B1. 查看全量订阅
- 角色: `admin`
- 用户输入: `列出所有订阅`
- 预期行为: 触发 `list`，管理员模式可见全量订阅。
- 关键断言:
  - 列表可包含多用户数据。
  - 每条记录显示创建人信息（`createdByUsername` 或 `userId`）。

### B2. 按创建人筛选列表
- 角色: `admin`
- 用户输入: `列出创建人 alice 的订阅`
- 预期行为: 触发 `list`，透传 `username=alice` 调用 `GET /api/subscriptions?username=alice`。
- 关键断言:
  - 返回订阅应主要为 alice 创建的记录。

### B3. 管理员修改订阅归属
- 角色: `admin`
- 用户输入: `把“钉钉交易提醒”归属到用户ID 22222222-2222-2222-2222-222222222222`
- 预期行为: 触发 `update`，patch 包含 `userId=2222...`，调用 `PUT /api/subscriptions/:id`。
- 关键断言:
  - 返回更新回显中的 `用户ID` 已变化。

---

## C. 交互与鲁棒性

### C1. 目标不唯一时追问
- 角色: `admin` 或 `user`
- 用户输入: `修改订阅`
- 预期行为: 若命中多条候选，返回候选列表并要求回复序号或完整订阅 ID；进入 `select_target`。
- 关键断言:
  - 不应盲目更新任意一条。

### C2. 更新意图但缺少可更新字段时追问
- 角色: `admin` 或 `user`
- 用户输入: `编辑“钉钉交易提醒”`
- 预期行为: 进入 `update_patch`，追问要改哪些字段（例如 webhook、关键词、启用状态等）。
- 关键断言:
  - 追问应具体可执行，不应泛泛而谈。

### C3. 中途取消
- 角色: `admin` 或 `user`
- 用户输入: `取消`
- 预期行为: 清理 pending 状态，返回取消确认。
- 关键断言:
  - 后续再次输入应从新流程开始。
