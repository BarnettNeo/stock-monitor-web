## Context

目前 `TriggerLogDetailPage.vue` 页面的图表和数据展示存在多个问题：
1. **图表布局**：三个图表（K线、MACD、成交量）平分 1000px 高度，导致 K 线主图被压缩，且子图可能高度过大，整体视觉比例不协调。
2. **数据硬编码**：`triggerPrice` 和 `mainFlowIn` 被硬编码，误导用户。
3. **MACD 缺失**：后端返回了 MACD 数据（假设），但前端解析或渲染可能存在问题。
4. **MarkPoint 偏移**：K 线图上的触发点标记位置不准确。

## Goals / Non-Goals

**Goals:**
- **优化图表布局**：调整 ECharts Grid 配置，使 K 线图占据主要空间（如 60%），MACD 和成交量各占较小比例（如 20%）。
- **真实数据展示**：移除硬编码，优先展示快照中的真实触发价格；若无主力流入数据则隐藏该字段。
- **修复 MACD**：确保前端正确解析后端返回的 `indicator.macd` 数据并渲染。
- **校准标记点**：确保“跌幅至目标价”等标记点准确对应触发时间和价格。

**Non-Goals:**
- **后端新增主力流入计算**：本次仅修复前端显示，不涉及后端去对接新的主力流入数据源（除非现有 API 已包含）。

## Decisions

- **图表布局方案**：
  - 使用 ECharts 的多 Grid 布局，将三个图表整合在一个 Canvas 中，或调整 Flex 布局比例。
  - 考虑到现有代码是三个独立的 `flex-1` 容器，调整 CSS Flex 比例是最快且改动最小的方案。
  - **决定**：调整 Flex 比例，K线主图 `flex-[3]`，子图 `flex-[1]`。同时检查 ECharts `grid` 的 `top/bottom` 边距设置，减少空白。

- **数据源处理**：
  - `triggerPrice`：直接从 `log.snapshot` 中读取。如果 `snapshot` 为空，显示 N/A。
  - `mainFlowIn`：由于后端未计算，前端直接移除该字段显示，或者如果 `log.snapshot` 中有相关保留字段则显示，否则隐藏。鉴于目前后端完全没这数据，**决定隐藏该字段**。

- **MarkPoint 定位**：
  - ECharts 的 MarkPoint 需要 `xAxis`（时间）和 `yAxis`（价格）坐标。
  - 问题可能出在时间格式不匹配或坐标轴类型设置。
  - **决定**：在 `processKlineData` 中转换数据时，确保 MarkPoint 的时间格式与 K 线图 x 轴数据完全一致。

## Risks / Trade-offs

- **[MACD 数据格式不一致]** → Risk: 后端返回的 MACD 数据结构可能与前端预期不符（例如字段名大小写、嵌套层级）。
  - Mitigation: 在前端添加数据结构的 `console.log` 调试，并在代码中增加防御性检查（Optional Chaining）。
