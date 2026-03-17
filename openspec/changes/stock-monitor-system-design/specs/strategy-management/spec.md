## ADDED Requirements

### Requirement: 策略基础配置
The system SHALL allow users to create, read, update, and delete (CRUD) monitoring strategies, configuring monitoring stocks and scanning intervals.

#### Scenario: User creates a new strategy
- **WHEN** user inputs strategy name, stocks list, and interval, then saves
- **THEN** the system saves the strategy to the database and schedules it for scanning based on the specified interval

### Requirement: 扫描调度控制
The system SHALL execute scans based on a global scheduler configured via `SCAN_INTERVAL_MS`.

#### Scenario: Global interval triggers
- **WHEN** the `SCAN_INTERVAL_MS` timer ticks
- **THEN** the system iterates through all active strategies and performs market data fetching and condition checking
