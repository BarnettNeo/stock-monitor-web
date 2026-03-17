## 1. 前端：路由与布局

- [x] 1.1 在 `admin/src/router.ts` 新增大屏路由（例如 `/screen`）并指向新页面组件
- [x] 1.2 在 `admin/src/App.vue` 增加大屏布局分流逻辑（全屏模式不显示侧边栏/顶部栏）

## 2. 前端：大屏首页实现

- [x] 2.1 新增页面 `admin/src/views/ScreenHomePage.vue`（或同命名风格）并搭建页面骨架：Header + KPI 卡片 + 两栏中区 + 列表区 + 详情区
- [x] 2.2 封装基础数据模型与请求：新增 `admin/src/api/dashboard.ts`（或复用现有 `api.ts`）
- [x] 2.3 接入 ECharts：实现“今日触发趋势”折线图组件
- [x] 2.4 实现“实时触发动态”滚动列表（支持查看全部跳转到 `/trigger-logs`）
- [x] 2.5 实现“重点关注股票”列表展示（TopN），包含价格与涨跌幅样式
- [x] 2.6 实现“最近一次异动详情”预览：点击/自动选择最近触发，加载 `/api/trigger-logs/:id` 并渲染迷你 K 线
- [x] 2.7 增加刷新策略（自动刷新 + 手动刷新 + 页面不可见暂停）

## 3. 后端（推荐）：大屏聚合 API

- [x] 3.1 新增路由 `GET /api/dashboard/screen`：返回 KPI、趋势、最新触发、watchlist、最近触发 id
- [x] 3.2 复用现有 DB 表：`strategies`、`trigger_logs`，使用 SQL 做聚合统计（今日触发数、按小时趋势）
- [x] 3.3 watchlist：从启用策略聚合 symbols，调用 `fetchStockDataBatch` 获取报价并返回 TopN

## 4. 验证

- [ ] 4.1 本地启动 `admin` 与 `server`，验证 `/screen` 可访问且不影响现有页面
- [ ] 4.2 验证无 token 时仍会按现有逻辑跳转登录
- [ ] 4.3 验证趋势图、滚动列表、详情区在无数据/接口失败时可正常降级显示
