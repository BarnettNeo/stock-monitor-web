## ADDED Requirements

### Requirement: 大屏首页信息结构
The system SHALL display a Big Screen home page composed of real-time monitoring KPIs and visual charts.

#### Scenario: User views the big screen home
- **WHEN** the Big Screen home loads
- **THEN** the system shows:
  - KPI cards: running strategies, today's triggers, push success, monitored symbols
  - real-time trigger feed (scrolling)
  - today's trigger trend chart
  - watchlist (focus symbols) with quote and change percent
  - latest trigger detail preview

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

