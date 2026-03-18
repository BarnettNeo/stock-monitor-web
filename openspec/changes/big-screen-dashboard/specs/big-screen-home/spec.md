## ADDED Requirements

### Requirement: 大屏首页信息结构
The system SHALL display a Big Screen home page composed of real-time monitoring KPIs and visual charts.

#### Scenario: User views the big screen home
- **WHEN** the Big Screen home loads
- **THEN** the system shows:
  - KPI cards: running strategies, today's triggers, push success, monitored symbols
  - real-time trigger feed (scrolling)
  - today's trigger trend chart
  - focus stocks panel with selector + close-price line chart
  - hot movers panels: top 10 gainers and top 10 losers (recent 3 days)
  - hot stock analysis panel (placeholder)
  - latest trigger detail preview

### Requirement: 重点关注股票（下拉选择 + 收盘价折线图）
The system SHALL allow the user to select a focus symbol from their configured symbol list and view a close-price line chart.

#### Scenario: Focus symbol options are loaded
- **WHEN** the Big Screen home loads
- **THEN** the system loads the focus symbol options for the current user
- **AND** the system selects a default symbol when options are non-empty

#### Scenario: User switches focus symbol
- **WHEN** the user selects a different symbol
- **THEN** the system fetches the symbol's recent K-line data
- **AND** the system renders a line chart using close prices only

#### Scenario: No configured symbols
- **WHEN** the current user has no configured symbols
- **THEN** the system shows an empty state for the focus stocks panel

### Requirement: 近3日热门上涨/下跌榜单
The system SHALL display top movers (gainers/losers) computed from recent 3-day performance.

#### Scenario: User views hot gainers/losers
- **WHEN** the Big Screen home loads
- **THEN** the system shows:
  - top 10 hot gainers for the recent 3 days
  - top 10 hot losers for the recent 3 days

#### Scenario: Periodic refresh for hot movers
- **WHEN** the Big Screen page remains open
- **THEN** the system refreshes hot movers data at a 10-minute interval
- **AND** the refresh interval for hot movers is independent from the main screen refresh interval

### Requirement: 热门股票分析占位
The system SHALL display a placeholder panel for hot stock analysis.

#### Scenario: User views the analysis panel
- **WHEN** the Big Screen home loads
- **THEN** the system shows the hot stock analysis panel as blank content (placeholder)

### Requirement: 自动刷新与手动刷新
The system SHALL refresh Big Screen data periodically and allow manual refresh.

#### Scenario: Periodic refresh
- **WHEN** the Big Screen page is visible
- **THEN** the system refreshes data at a configurable interval (default 5~10 seconds)

#### Scenario: Page is hidden
- **WHEN** the document becomes hidden
- **THEN** the system pauses background refreshing to reduce unnecessary load

#### Scenario: Manual refresh
- **WHEN** the user clicks the refresh action
- **THEN** the system fetches the latest data immediately

### Requirement: 数据降级
The system SHALL degrade gracefully when partial data is unavailable.

#### Scenario: Aggregate API not available
- **WHEN** the aggregate dashboard API fails
- **THEN** the system shows last known data (if any) and a non-blocking error state, and MAY fallback to basic existing APIs where possible

