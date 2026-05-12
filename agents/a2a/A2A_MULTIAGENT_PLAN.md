# A2A 多 Agent 协作方案（已落地：指挥官-工人模式）

背景：当前 `agents/` 侧已实现“检索与归因”（RAG + Attribution），本文档补齐并固化 **新闻抓取/清洗/入库** 的完整流水线，并用 A2A 多 agent 协作把职责拆分、可独立选型不同 LLM 模型。

本仓库已采用 **Commander-Worker（指挥官-工人）模式**：

- **Ingest Worker（新闻抓取/清洗/入库）**：RSS/Atom 拉取 → 文章正文抓取 → 清洗抽取文本 → 分块 → Embedding → 写入 Milvus
- **Retrieval Worker（检索与归因）**：根据用户查询/触发原因，从 Milvus 检索相关新闻 → 归因（含 citations）
- **Thinking Worker（思考执行/最终答复）**：基于归因结果输出最终用户答复（结论 + 要点 + 追问）
- **Commander（指挥官）**：统一编排上述 worker；在线问答可按需 `forceIngest`，生产推荐走后台定时入库

---

## 1. 推荐架构：Commander-Worker

为什么推荐 Commander-Worker：
1) 对外 API 入口清晰，便于鉴权/限流/观测  
2) Worker 解耦，可单独替换实现与模型（不同 LLM）  
3) 入库任务天然适合后台定时/队列，避免阻塞问答路径  

---

## 2. 代码落点（已实现）

### 2.1 Agents 侧（Python / FastAPI）

- `agents/a2a/commander.py`：指挥官编排（可选 ingest → retrieval → thinking）
- `agents/a2a/ingest_agent.py`：抓取/清洗/分块/embedding/Milvus upsert（含增量去重）
- `agents/a2a/retrieval_agent.py`：封装 `agents/domain/attribution.py` 作为检索归因 worker（支持模型 override）
- `agents/a2a/thinking_agent.py`：最终答复 worker（支持模型 override）
- `agents/a2a/api.py`：A2A 路由（`/a2a/*`）
- `agents/main.py`：已挂载 A2A router

Milvus 写入与 schema：
- `agents/infrastructure/milvus_news.py`：新增 `upsert_chunks()`；collection 不存在时自动建表

### 2.2 Server 侧（Node/Express）

入库定时任务（cron/worker）：
- `server/src/scheduler.ts`：新增新闻入库调度逻辑（`NEWS_INGEST_INTERVAL_MS` 控制），定期调用 agents 的 `POST /a2a/ingest/run`

入库运行记录落库（可观测 + 增量窗口依据）：
- `server/src/db.ts`：新增表 `news_ingest_runs`

---

## 3. API（对外调用方式）

### 3.1 手动运行入库（抓取/清洗/入库）

`POST /a2a/ingest/run`

- Header（可选）：`x-trace-id`（用于链路追踪；server 定时任务会自动传）
- Body：
```json
{
  "symbols": ["sh600519"],
  "sinceMinutes": 180,
  "maxItems": 30,
  "dryRun": false,
  "feeds": []
}
```

返回值会包含：
- `meta.traceId`：本次入库 trace id

### 3.2 A2A Chat（检索归因 + 最终答复）

`POST /a2a/chat`

```json
{
  "message": "茅台今天为什么涨？",
  "symbol": "sh600519",
  "stockName": "贵州茅台",
  "eventReason": "",
  "windowMinutes": 60,
  "context": {
    "retrievalModel": "qwen3-max",
    "thinkingModel": "qwen-plus",
    "forceIngest": false
  }
}
```

说明：
- `context.forceIngest=true`：在线问答前先跑一次入库（适合“先更新再问”）
- 生产推荐：**问答默认不入库**；入库交给 server 定时任务

---

## 4. 入库改为定时任务（cron/队列 worker）

当前实现为 **server 内置定时 worker**（无需额外队列系统）：

- 开关：`.env` 中配置 `NEWS_INGEST_INTERVAL_MS>0`
- 执行：`server/src/scheduler.ts` 会周期调用 `AGENTS_BASE_URL/a2a/ingest/run`
- 防重入：同一时刻只允许一个入库任务运行
- 运行记录：写入 MySQL 表 `news_ingest_runs`

如果你希望改成“队列 worker”（例如 BullMQ/Redis、RabbitMQ），建议保持 `POST /a2a/ingest/run` 作为幂等执行单元，把调度与执行拆分；现有结构可直接演进。

---

## 5. 增量去重策略（canonical url + simhash）

目标：避免重复入库、避免同一文章不同参数 URL / 同内容重复写入。

已实现：

1) **canonical url**
   - 去掉 `#fragment`
   - 过滤常见追踪参数（`utm_* / spm / gclid / fbclid ...`）
   - query 参数排序
   - 作为最终写入的 `url` 字段（更稳定）

2) **simhash64（文本近重复指纹）**
   - 对抽取的正文文本计算 simhash64（hex）
   - 与 canonical url 组合成 `dedup_hint`
   - `dedup_hint` 参与 `doc_id`（primary key）哈希生成，使 upsert 幂等更强

实现位置：
- canonical + simhash：`agents/a2a/ingest_agent.py`
- `doc_id` 生成与 upsert：`agents/infrastructure/milvus_news.py`

---

## 6. 可观测 trace_id（链路追踪 + 结构化日志）

目标：把一次入库任务在 server→agents→milvus 的链路串起来，便于排障与统计。

已实现：

- server 每次入库生成 `traceId`，通过 Header `x-trace-id` 传给 agents：`server/src/scheduler.ts`
- agents 接收 `x-trace-id`，回传 `meta.traceId`：`agents/a2a/api.py`
- ingest worker 输出 JSON 结构化日志（start/end）包含 `traceId` 与计数：`agents/a2a/ingest_agent.py`
- server 将结果（含 traceId、计数、errors、meta）写入 `news_ingest_runs`：`server/src/db.ts` + `server/src/scheduler.ts`

---

## 7. 配置（.env）

### 7.1 News ingest（agents 侧）
- `NEWS_RSS_FEEDS`：逗号分隔 RSS/Atom URL（必填）
- `NEWS_HTTP_TIMEOUT`：抓取超时
- `NEWS_CHUNK_CHARS / NEWS_CHUNK_OVERLAP`：分块参数

### 7.2 Server-side ingest scheduler（server 侧）
- `NEWS_INGEST_INTERVAL_MS`：>0 启用定时入库（例如 `300000`=5分钟）
- `NEWS_INGEST_SYMBOLS`：可选；为空则从启用策略收集 symbol（最多 200）
- `NEWS_INGEST_SINCE_MINUTES`：<=0 时自动按上次成功入库时间计算增量窗口
- `NEWS_INGEST_MAX_ITEMS`：每次入库最多处理 feed items 数

### 7.3 多模型路由（每个 agent 一个）
- `A2A_MODEL_RETRIEVAL`
- `A2A_MODEL_THINKING`

也可在 `POST /a2a/chat` 的 `context.retrievalModel / context.thinkingModel` 单次覆盖（带安全校验）。

### 7.4 使用 `agents/a2a/agent.yaml` 连通多模型/多 provider

本项目支持从 `agents/a2a/agent.yaml` 读取每个 worker 的 `model/provider`（启动时加载）。

为了让 `provider` 生效，需要在 `.env` 中配置对应 provider 的 base_url/api_key（可选 model 默认值）：

- `LLM_BASE_URL_<PROVIDER>`
- `LLM_API_KEY_<PROVIDER>`
- `LLM_MODEL_<PROVIDER>`（可选；未填则按默认策略回退）

示例：当 `provider: zhipuai` 时，读取 `LLM_BASE_URL_ZHIPUAI` / `LLM_API_KEY_ZHIPUAI`。

---

## 8. 生产化下一步（可选增强）

- 抽象“新闻源适配层”：RSS + 站点正文抽取（Readability）+ 公告/API
- 更强去重：canonical + simhash 的同时，增加 URL 规范化白名单/黑名单与相似度阈值策略
- 指标化：对 `news_ingest_runs` 增加更多耗时字段（fetch/embed/milvus），接 Prometheus/Grafana
