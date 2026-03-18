## ADDED Requirements

### Requirement: 优化 K 线图表布局
系统 MUST 优化 `TriggerLogDetailPage` 的图表布局，使 K 线主图在容器中占据主导高度（如 60%），MACD 和成交量各占较小比例（如 20%），并减少图表周边的空白区域。

#### Scenario: 用户查看详情页
- **WHEN** 用户进入触发日志详情页
- **THEN** K 线图应清晰可见且未被过度压缩，MACD 和成交量子图显示完整。

### Requirement: 修复 MACD 数据显示
系统 MUST 正确解析后端返回的 `indicator.macd` 数据，并在子图 1 中正确渲染 DIF、DEA 和 MACD 柱状图。

#### Scenario: 触发快照包含 MACD 数据
- **WHEN** 后端返回的快照数据中包含有效的 MACD 指标数据
- **THEN** 详情页的 MACD 子图应显示相应的曲线和柱状图，而非空白。

### Requirement: 校准 MarkPoint 位置
系统 MUST 确保 K 线图上的“跌幅至目标价”等 MarkPoint 标记准确对应到触发时刻的价格坐标上。

#### Scenario: 策略因达到目标价触发
- **WHEN** 渲染触发点标记时
- **THEN** 标记点应准确位于触发时间对应的 K 线位置上方或下方，且数值显示正确。
