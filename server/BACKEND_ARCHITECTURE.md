# Stock Monitor Web - Server 后端设计架构

## 1. 范围与目标

本文件描述 `server`（Node.js + Express + TypeScript）后端的整体架构、模块职责、核心数据流、鉴权模型、数据库结构、定时扫描（scheduler）与推送链路。

目标：

- 明确各模块边界与依赖关系，便于后续扩展与维护
- 保持“策略扫描 -> 触发 -> 推送 -> 触发日志落库”的闭环清晰可追踪
- 支持多用户（admin/user）及权限控制

## 2. 技术栈与运行时

- 语言：TypeScript
- Web 框架：Express
- 文档：OpenAPI JSON + Swagger UI
- 数据库：SQLite（使用 `sql.js` WASM 内存数据库 + 文件落盘持久化）
- 定时任务：Node.js `setInterval`
- 推送渠道：钉钉机器人、企业微信机器人、企业微信应用（预留/支持）

默认端口：`3001`（可通过 `PORT` 环境变量覆盖）。

## 3. 目录结构与模块职责

### 3.1 入口与装配

- `src/index.ts`

职责：

- 初始化 Express（`cors`、`express.json`）
- 提供健康检查 `/api/health`
- 暴露 OpenAPI `/openapi.json` 与 Swagger UI `/api-docs`
- 注册路由模块
- 启动 scheduler（策略扫描）

入口文件只负责“组装”，不承载业务实现。

### 3.2 认证与授权

- `src/auth.ts`

职责：

- `signToken(payload)`：签发 HS256 JWT（轻量实现，避免引入额外依赖）
- `requireAuth(req,res)`：
  - 读取 `Authorization: Bearer <token>`
  - 校验 token 签名/过期
  - 查询 `users` 表获取用户信息（并返回 `AuthedUser`）
  - 未认证返回 `401`
- `pbkdf2Hash(password, salt)`：PBKDF2 派生密码哈希
- 常量：`AUTH_ADMIN_USER_ID = "admin"`

角色：

- `admin`：全权限
- `user`：只能编辑/删除自己创建的数据（策略、订阅）

### 3.3 工具函数

- `src/utils.ts`

职责：

- 时间与类型辅助：`nowIso()`、`intToBool()`、`boolToInt()`
- API 错误统一处理：`handleApiError()` / `formatZodError()`

### 3.4 DB Row 映射

- `src/mappers.ts`

职责：将 `sql.js` 返回的 row 对象转换为 API DTO。

- `rowToStrategy(row)`：
  - 解析 `subscription_ids_json`
  - 兼容缺省字段（如 `market_time_only`）
  - 返回策略对象（含 target/percent 模式字段）
- `rowToSubscription(row)`：
  - 将 `wecom_app_*` 字段组合为 `wecomApp` 对象

### 3.5 路由层（HTTP API）

路由模块统一对外提供 `registerXxxRoutes(app)` 方法，在入口处注册。

- `src/routes/auth-routes.ts`
  - `POST /api/auth/register`：注册用户
  - `POST /api/auth/login`：登录获取 token
  - `GET /api/auth/me`：获取当前用户

- `src/routes/strategies-routes.ts`
  - `GET /api/strategies`：策略列表（支持 name/username 查询，返回 `createdByUsername`）
  - `GET /api/strategies/:id`：查询单个策略
  - `POST /api/strategies`：创建策略
  - `PUT /api/strategies/:id`：更新策略（权限校验）
  - `DELETE /api/strategies/:id`：删除策略（权限校验）

- `src/routes/subscriptions-routes.ts`
  - `GET /api/subscriptions`：订阅列表（支持 name/username 查询，返回 `createdByUsername`）
  - `GET /api/subscriptions/:id`
  - `POST /api/subscriptions`
  - `PUT /api/subscriptions/:id`（权限校验）
  - `DELETE /api/subscriptions/:id`（权限校验）

- `src/routes/trigger-logs-routes.ts`
  - `GET /api/trigger-logs`：触发日志列表（最多 200 条）

### 3.6 数据库与迁移

- `src/db.ts`

职责：

- 初始化 `sql.js` 数据库实例
- 通过 `migrate(database)` 进行建表/增量迁移
- 使用 `persist()` 将内存 DB `export()` 后写入 `server/data/db.sqlite`

关键点：

- `sql.js` 是内存数据库：每次写入后需要 `persist()` 才能落盘
- `getDb()` 初始化后会立即调用 `persist()`，确保 schema 写入文件

### 3.7 策略引擎

- `src/engine.ts`

职责：

- 从外部行情接口批量拉取股票最新数据：`fetchStockDataBatch(codes)`
- 计算技术指标快照：MACD / RSI / 均线
- 根据策略配置产生触发事件：`runStrategyOnce(strategy)`

核心策略概念：

- `alertMode`（二选一）：
  - `percent`：使用 `priceAlertPercent` 做涨跌幅触发
  - `target`：使用 `targetPriceUp` / `targetPriceDown` 做目标价触发
- `cooldownMinutes`：冷却时间（同一策略、同一股票、同一原因在冷却期内不重复推送）
- `marketTimeOnly`：只在交易时间推送

### 3.8 推送与消息模板

- `src/message-templates.ts`
  - 将 TriggerEvent 构建为统一 markdown 结构

- `src/notify.ts`
  - `notifyBySubscription(sub, payload)`：按订阅类型选择 notifier 发送

- `src/notifiers/*`
  - 钉钉 / 企微机器人 / 企微应用消息发送的底层实现

### 3.9 定时扫描（Scheduler）

- `src/scheduler.ts`

职责：

- `scanOnce()`：
  - 读取启用的订阅（`subscriptions` enabled=1）并构建 `subMap`
  - 读取启用的策略（`strategies` enabled=1）并组装为 `engine.Strategy`
  - 对每个策略执行 `runStrategyOnce()`
  - 将事件分发到策略绑定的订阅（或无订阅时仅落库）
  - 每次推送/不推送都写入 `trigger_logs`
  - 扫描完成后 `persist()` 落盘

- `startScheduler()`：
  - 启动时先执行一次 `scanOnce()`
  - 之后按 `SCAN_INTERVAL_MS`（默认 15000ms）周期执行

## 4. 核心数据流（端到端）

### 4.1 策略执行与触发日志闭环

1. scheduler 周期性触发 `scanOnce()`
2. `scanOnce()` 读取启用策略与订阅
3. 对每个策略：调用 `engine.runStrategyOnce(strategy)`
4. `runStrategyOnce` 产生 `TriggerEvent[]`（包含原因与快照）
5. 对每个事件：
   - 若策略绑定订阅：逐订阅发送 -> 逐条写入 `trigger_logs`
   - 若无绑定订阅：写入一条 `NO_SUBSCRIPTION` 状态的日志
6. `persist()` 落盘
7. 管理后台通过 `/api/trigger-logs` 回看触发原因、快照与发送错误

### 4.2 用户鉴权与权限校验

1. 前端登录：`POST /api/auth/login` 获取 `token`
2. 后续请求都携带：`Authorization: Bearer <token>`
3. 路由层调用 `requireAuth(req,res)` 获取用户信息
4. 对写操作（PUT/DELETE）：
   - `admin` 允许修改任何记录
   - `user` 仅允许修改 `user_id == 当前 userId` 的记录

## 5. 数据库模型（SQLite）

数据库文件：`server/data/db.sqlite`。

### 5.1 users

- `id` (TEXT, PK)：系统内部 userId（约定与 username 一致）
- `username` (TEXT, UNIQUE)
- `password_salt` (TEXT)
- `password_hash` (TEXT)
- `role` (TEXT)：`admin`/`user`
- `created_at` / `updated_at` (TEXT)

### 5.2 strategies

- `id` (TEXT, PK)
- `user_id` (TEXT)
- `name` (TEXT)
- `enabled` (INTEGER)
- `symbols` (TEXT)：逗号分隔的股票代码
- `market_time_only` (INTEGER)
- `alert_mode` (TEXT)：`percent`/`target`
- `target_price_up` / `target_price_down` (REAL)
- `interval_ms` (INTEGER)
- `cooldown_minutes` (INTEGER)
- `price_alert_percent` (REAL)
- 指标开关（INTEGER）：
  - `enable_macd_golden_cross`
  - `enable_rsi_oversold`
  - `enable_rsi_overbought`
  - `enable_moving_averages`
  - `enable_pattern_signal`
- `subscription_ids_json` (TEXT)：JSON 数组字符串
- `created_at` / `updated_at` (TEXT)

### 5.3 subscriptions

- `id` (TEXT, PK)
- `user_id` (TEXT)
- `name` (TEXT)
- `type` (TEXT)：`dingtalk` / `wecom_robot` / `wecom_app`
- `enabled` (INTEGER)
- `webhook_url` (TEXT)
- `keyword` (TEXT)
- 企业微信应用字段：
  - `wecom_app_corp_id`
  - `wecom_app_corp_secret`
  - `wecom_app_agent_id`
  - `wecom_app_to_user`
  - `wecom_app_to_party`
  - `wecom_app_to_tag`
- `created_at` / `updated_at`

### 5.4 trigger_logs

- `id` (TEXT, PK)
- `user_id` (TEXT)
- `strategy_id` (TEXT)
- `subscription_id` (TEXT, nullable)
- `symbol` (TEXT)
- `stock_name` (TEXT)
- `reason` (TEXT)
- `snapshot_json` (TEXT)
- `send_status` (TEXT)：`SENT`/`FAILED`/`NO_SUBSCRIPTION`
- `send_error` (TEXT)
- `created_at` (TEXT)

## 6. 配置与环境变量

- `PORT`：服务端口（默认 3001）
- `SCAN_INTERVAL_MS`：scheduler 扫描间隔（默认 15000）
- `AUTH_SECRET`：JWT 签名密钥（生产环境必须设置且足够随机）

## 7. 可观测性与错误处理

- 路由层：通过 `handleApiError` 统一处理 Zod 校验与未知异常
- scheduler：对单策略执行做 try/catch，避免一条策略异常导致全局任务停止
- trigger_logs：记录“每次触发与发送结果”，便于在管理后台回看与追责

## 8. 扩展点与建议

- OpenAPI：当前为静态 `openapi.ts`，后续可补全 schema 与鉴权说明
- Scheduler 并发：当前顺序执行策略；策略数量上来后可考虑并发与限流
- 权限模型：当前为“按记录 user_id 所有权 + admin 全权”，可扩展为更细粒度
- 数据表外键：目前未显式声明外键约束（sqlite/sql.js 兼容考虑），需要强约束可后续补充

---

本文档用于帮助快速理解后端架构与数据流；当新增模块或核心行为变化时建议同步更新。
