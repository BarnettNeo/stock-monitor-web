## ADDED Requirements

### Requirement: 大屏路由入口
The system SHALL provide a dedicated Big Screen route (e.g. `/screen`) for monitoring overview.

#### Scenario: User navigates to the big screen
- **WHEN** an authenticated user opens `/screen`
- **THEN** the system renders the Big Screen home page

#### Scenario: Unauthenticated access
- **WHEN** a user without a valid auth token opens `/screen`
- **THEN** the system redirects the user to `/login`

### Requirement: 全屏布局
The system SHALL render the Big Screen route in a full-screen layout without the admin sidebar/header navigation.

#### Scenario: Big screen layout isolation
- **WHEN** the current route matches `/screen`
- **THEN** the system hides the admin layout chrome and only shows the big screen content

