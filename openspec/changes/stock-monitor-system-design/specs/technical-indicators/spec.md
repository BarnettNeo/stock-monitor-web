## ADDED Requirements

### Requirement: MACD 指标触发
The system SHALL detect MACD golden cross signals as a bullish trend indicator.

#### Scenario: MACD Golden Cross occurs
- **WHEN** the fast line crosses above the slow line in the MACD indicator
- **THEN** the system triggers a MACD indicator alert

### Requirement: RSI 极值提醒
The system SHALL monitor RSI for overbought and oversold conditions.

#### Scenario: RSI reaches oversold territory
- **WHEN** the RSI value drops below the oversold threshold
- **THEN** the system triggers an RSI extreme value alert

### Requirement: 形态信号识别
The system SHALL detect specific price action patterns such as breakout pullbacks (突破回踩) and breakdown retests (破位反抽).

#### Scenario: Breakout pullback detected
- **WHEN** the recent price sequence matches the "突破回踩" pattern
- **THEN** the system triggers a pattern signal alert
