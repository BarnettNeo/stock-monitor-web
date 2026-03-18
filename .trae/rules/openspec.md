---
alwaysApply: false
description: OpenSpec 工作规则
---
# OpenSpec 工作规则

## 默认行为
- 始终优先读取 @openspec/AGENTS.md
- 变更开发时自动定位 openspec/changes/ 目录
- 代码生成后自动对照 spec.md 验证

## 文件引用规则
- 小功能：只引用相关 spec 文件
- 大功能：分批次引用，避免一次性加载全部
