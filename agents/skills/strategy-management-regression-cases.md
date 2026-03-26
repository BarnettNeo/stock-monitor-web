# Strategy Management 回归样例

## 使用说明
- 目标: 回归验证 `strategy_management` skill 的意图识别、目标定位、权限控制和字段更新完整性。
- 执行方式: 在前端或直接调用 `POST /api/agent/chat`，逐条发送“用户输入”。
- 判定方式: 对照“预期行为”和“关键断言”检查结果。

---

## A. 普通用户场景

### A1. 查询自己的策略列表
- 角色: `user`
- 用户输入: `列出我的策略`
- 预期行为: 触发 `list`，调用 `GET /api/strategies`，skill 侧仅展示当前用户策略。
- 关键断言:
  - 返回中不应出现其他用户策略。
  - 每条记录包含名称、状态、symbols、ID。

### A2. 查看策略详情（按名称定位）
- 角色: `user`
- 用户输入: `查看“短线波动策略”详情`
- 预期行为: 触发 `get`，根据名称定位目标；若唯一命中则调用 `GET /api/strategies/:id`。
- 关键断言:
  - 返回详情字段: `name/symbols/enabled/alertMode/priceAlertPercent/intervalMs/cooldownMinutes`。

### A3. 修改策略单字段（停用）
- 角色: `user`
- 用户输入: `停用短线波动策略`
- 预期行为: 触发 `update`，自动构造 patch `enabled=false`，调用 `PUT /api/strategies/:id`。
- 关键断言:
  - 更新后状态显示为停用。
  - 不应要求用户手动输入全部字段。

### A4. 修改多字段（口语化）
- 角色: `user`
- 用户输入: `把短线波动策略改成仅交易时段监控，阈值3%，冷却30分钟，开启均线，关闭形态识别`
- 预期行为: 触发 `update`，patch 至少包含:
  - `marketTimeOnly=true`
  - `priceAlertPercent=3`
  - `cooldownMinutes=30`
  - `enableMovingAverages=true`
  - `enablePatternSignal=false`
- 关键断言:
  - `PUT` 成功且字段生效。

### A5. 清空订阅绑定
- 角色: `user`
- 用户输入: `把这个策略的订阅清空`
- 预期行为: 触发 `update`，patch 包含 `subscriptionIds=[]`。
- 关键断言:
  - 更新后策略 `subscriptionIds` 为空数组。

### A6. 越权保护（普通用户尝试改 userId）
- 角色: `user`
- 用户输入: `把这个策略归属到用户ID 11111111-1111-1111-1111-111111111111`
- 预期行为: skill 会丢弃 patch 中的 `userId`，不允许普通用户改归属。
- 关键断言:
  - 更新请求体中 `userId` 仍应是当前策略原归属（或当前用户）。
  - 无越权修改发生。

### A7. 删除策略
- 角色: `user`
- 用户输入: `删除短线波动策略`
- 预期行为: 触发 `delete`，若唯一命中则调用 `DELETE /api/strategies/:id`。
- 关键断言:
  - 删除成功返回 `ok` 或删除确认文案。

---

## B. 管理员场景

### B1. 查看全量策略
- 角色: `admin`
- 用户输入: `列出所有策略`
- 预期行为: 触发 `list`，管理员模式下可见全量策略。
- 关键断言:
  - 列表可包含多个用户的数据。
  - 每条会显示 `创建人`（`createdByUsername` 或 `userId`）。

### B2. 按创建人筛选列表
- 角色: `admin`
- 用户输入: `列出创建人 alice 的策略`
- 预期行为: 触发 `list`，透传 `username=alice` 调用 `GET /api/strategies?username=alice`。
- 关键断言:
  - 返回策略应主要为 alice 创建的记录。

### B3. 按创建人 + 策略名定位并查看
- 角色: `admin`
- 用户输入: `查看 alice 的“日内监控”策略详情`
- 预期行为: 触发 `get`，定位时允许 owner/name 组合匹配；命中后调用 `GET /api/strategies/:id`。
- 关键断言:
  - 返回详情包含 `创建人` 字段。

### B4. 管理员修改策略归属
- 角色: `admin`
- 用户输入: `把“日内监控”策略归属到用户ID 22222222-2222-2222-2222-222222222222`
- 预期行为: 触发 `update`，patch 包含 `userId=2222...`，调用 `PUT /api/strategies/:id`。
- 关键断言:
  - 返回更新回显中的 `用户ID` 已变化。

### B5. 管理员全字段更新（覆盖型）
- 角色: `admin`
- 用户输入: `把“日内监控”改成名字“日内监控V2”，symbols 改为 sh600519,sz000001，目标价模式，上涨2200，下跌1800，间隔2分钟，冷却15分钟，启用MACD金叉，关闭RSI超卖，关闭RSI超买，开启均线，开启形态信号，订阅ID为 33333333-3333-3333-3333-333333333333`
- 预期行为: 触发 `update`，patch 至少覆盖:
  - `name`
  - `symbols`
  - `alertMode=target`
  - `targetPriceUp/targetPriceDown`
  - `intervalMinutes/cooldownMinutes`
  - 5 个指标开关
  - `subscriptionIds`
- 关键断言:
  - `PUT` 成功，字段全部生效。

### B6. 管理员跨用户删除策略
- 角色: `admin`
- 用户输入: `删除 bob 的“日内监控V2”策略`
- 预期行为: 触发 `delete`，管理员可定位并删除非本人策略。
- 关键断言:
  - 删除成功，不受普通用户所有权限制。

---

## C. 交互与鲁棒性

### C1. 目标不唯一时追问
- 角色: `admin` 或 `user`
- 用户输入: `修改短线策略`
- 预期行为: 若命中多条，返回候选列表并要求回复序号或 ID。
- 关键断言:
  - 不应盲目更新任意一条。

### C2. 缺少关键信息时追问（创建）
- 角色: `user`
- 用户输入: `帮我新建一个策略`
- 预期行为: 进入 `create_missing`，追问 symbols/条件类型等必要字段。
- 关键断言:
  - 至少有 1~2 个聚焦问题，不应一次问过多。

### C3. 中途取消
- 角色: `admin` 或 `user`
- 用户输入: `取消`
- 预期行为: 清理 pending 状态，返回取消确认。
- 关键断言:
  - 后续再次输入应从新流程开始。
