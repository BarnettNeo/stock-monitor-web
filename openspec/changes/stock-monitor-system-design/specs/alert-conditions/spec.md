## ADDED Requirements

### Requirement: 大幅异动监控（percent）
The system SHALL support alerting based on percentage changes from the base price.

#### Scenario: Price drops below threshold
- **WHEN** the `abs(changePercent) >= priceAlertPercent` is met
- **THEN** the system triggers an alert for the specific stock

### Requirement: 目标价触发（target）
The system SHALL support alerting based on absolute target prices, which overrides percentage-based alerts when enabled.

#### Scenario: Price reaches upper target
- **WHEN** `currentPrice >= targetPriceUp`
- **THEN** the system triggers a "涨幅至目标价" alert

#### Scenario: Price drops to lower target
- **WHEN** `currentPrice <= targetPriceDown`
- **THEN** the system triggers a "跌幅至目标价" alert
