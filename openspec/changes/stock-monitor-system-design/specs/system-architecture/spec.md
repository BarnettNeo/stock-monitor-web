## ADDED Requirements

### Requirement: 前后端分离架构
The system SHALL operate as a decoupled application with a Vue3-based Admin frontend and a Node.js backend exposing REST APIs.

#### Scenario: Admin interface interacts with backend
- **WHEN** the user opens the admin panel and views the strategy list
- **THEN** the frontend fetches data via REST API endpoints (`/api/strategies`) provided by the backend

### Requirement: 轻量级持久化存储
The system SHALL use an in-memory SQLite database (`sql.js`) that persists data to a local disk file (`server/data/db.sqlite`) to minimize dependencies.

#### Scenario: Server restart with persisted data
- **WHEN** the server restarts
- **THEN** the system loads the database from the disk file and resumes monitoring without data loss
