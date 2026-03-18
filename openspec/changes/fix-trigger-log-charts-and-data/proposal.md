## Why

当前管理后台“触发日志详情页”存在图表显示异常（MACD 缺失、K 线图尺寸压缩）和关键数据错误（触发价、主力流入显示为硬编码值）的问题。为了提供准确的分析辅助，需要修复图表渲染逻辑并对接真实数据。

## What Changes

- **图表修复**：
  - 修复 MACD 指标数据处理逻辑，确保子图 1 正确显示。
  - 优化 ECharts 布局配置（Grid），解决 K 线主图和成交量子图高度被压缩的问题，使其充分利用容器空间。
  - 修正 K 线图中“跌幅至目标价”标记点（MarkPoint）的位置计算逻辑。
- **数据对接**：
  - 移除前端硬编码的 `triggerPrice`（1780）和 `mainFlowIn`（12500000）。
  - 改为优先使用后端返回的快照数据中的触发价格。
  - 对于“主力流入”字段，鉴于后端暂未提供计算，前端暂时隐藏该字段或显示为“暂无数据”（待定），避免误导用户。

## Capabilities

### New Capabilities

- `chart-visualization-fix`: 修复图表渲染与布局问题（MACD 数据映射、Grid 高度优化、MarkPoint 定位）。
- `data-integrity-fix`: 确保详情页展示的数据（价格、资金流）与触发日志快照真实数据一致。

### Modified Capabilities

- 

## Impact

- **admin**: `src/views/TriggerLogDetailPage.vue` 文件将进行大量逻辑修改。
- **server**: 本次主要为前端修复，暂不涉及后端接口变更（除非决定新增主力流入计算，但目前定义为修复现有显示问题）。
