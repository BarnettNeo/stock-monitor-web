## 1. 数据清理与硬编码移除

- [ ] 1.1 修改 `admin/src/views/TriggerLogDetailPage.vue`，移除 `triggerPrice` 的硬编码值，改为从 `log.snapshot` 读取
- [ ] 1.2 修改 `admin/src/views/TriggerLogDetailPage.vue`，移除 `mainFlowIn` 的硬编码值，若快照中无数据则隐藏该字段

## 2. 图表渲染与布局修复

- [ ] 2.1 修改 `admin/src/views/TriggerLogDetailPage.vue` 的 CSS Flex 布局，调整 K 线主图与子图的高度比例（建议 3:1:1）
- [ ] 2.2 优化 ECharts Grid 配置，减少图表周边的空白区域
- [ ] 2.3 检查并修复 `processKlineData` 中 MACD 数据的解析逻辑，确保 DIF/DEA/MACD 柱状图数据正确传递给 ECharts
- [ ] 2.4 修复 `processKlineData` 中 MarkPoint 的位置计算逻辑，确保时间坐标与 X 轴数据对齐

## 3. 验证与测试

- [ ] 3.1 启动前后端，访问一个已有的触发日志详情页，验证 MACD 是否显示
- [ ] 3.2 验证图表高度比例是否协调，K 线主图是否清晰
- [ ] 3.3 验证触发价格显示是否正确，主力流入是否已隐藏
- [ ] 3.4 验证 MarkPoint 标记位置是否准确对应触发时间点
