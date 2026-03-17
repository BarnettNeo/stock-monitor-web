## ADDED Requirements

### Requirement: 多渠道订阅推送
The system SHALL support multiple push channels, including DingTalk and Enterprise WeChat bots, and allow 0~N subscriptions per strategy.

#### Scenario: Strategy triggers with multiple subscriptions
- **WHEN** an alert condition is met for a strategy with multiple linked subscriptions
- **THEN** the system pushes notifications to each subscription channel independently and records their delivery statuses

### Requirement: 触发日志记录
The system SHALL record every trigger event, including the reason, snapshot of data, and push status, regardless of whether push channels are configured.

#### Scenario: Strategy triggers without subscriptions
- **WHEN** an alert condition is met for a strategy with no linked subscriptions
- **THEN** the system records the trigger log without attempting any external push

### Requirement: 推送冷却机制
The system SHALL prevent redundant push notifications for the same event within a configured cooldown period (`cooldownMinutes`).

#### Scenario: Same condition triggers within cooldown period
- **WHEN** the same stock triggers the same reason within the `cooldownMinutes` window
- **THEN** the system suppresses the push notification to avoid spam
