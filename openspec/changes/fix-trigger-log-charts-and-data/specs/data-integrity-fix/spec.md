## ADDED Requirements

### Requirement: 移除数据硬编码
系统 MUST 移除 `TriggerLogDetailPage` 页面中硬编码的 `triggerPrice` 和 `mainFlowIn` 字段。

#### Scenario: 页面加载
- **WHEN** 触发日志详情页加载完成
- **THEN** 触发价格应显示为日志快照中的真实价格，如果无价格则显示占位符或 N/A。

### Requirement: 隐藏无数据字段
系统 MUST 在后端未提供“主力流入”数据的情况下，在前端隐藏该字段或显示为“暂无数据”。

#### Scenario: 主力流入数据缺失
- **WHEN** 后端返回的触发日志快照中不包含主力流入数据
- **THEN** 详情页中应不显示“主力流入”这一项，避免显示默认的虚假数据（如 12500000）。
