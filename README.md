# 📈 股票监控AI助手 (Stock Monitor Agents)
由原轻量级股票监控与推送系统升级改造：
- 原分支：main
- 地址：https://github.com/BarnettNeo/stock-monitor-web/tree/main

## 🚀 核心升级

### 技术栈升级
- **大模型**: 通义千问Qwen3-Max，可选模型等
- **Agent框架**: LangChain 2026 + ReAct模式
- **记忆存储**: Redis / 内存级状态管理
- **架构解耦**: 数据库(SQLite)、定时任务(Scheduler)和消息通知(钉钉/企业微信)已完全下沉至 Node.js 服务端，Python层专注作为「自然语言意图编排网关」。

### 功能扩展
- ✅ **8个用户意图支持**
- ✅ **中文自然语言理解优化**
- ✅ **ReAct模式工具调用**
- ✅ **轻量级编排网关层设计**

## 📋 支持的用户意图

| 用户意图 | 示例命令 | 调用工具 |
|---------|---------|---------|
| 创建策略 | "帮我监控贵州茅台, MACD金叉时提醒我" | `create_strategy` |
| 查询策略 | "我现在有哪些监控策略?" | `list_strategies` |
| 删除策略 | "删除茅台的监控策略" | `delete_strategy` |
| 查询触发 | "今天有哪些股票触发了异动?" | `query_triggers` |
| 查询详情 | "查看茅台最近的异动诊断" | `get_diagnostic` |
| 订阅管理 | "帮我绑定钉钉推送地址" | `update_subscription` |
| 市场查询 | "贵州茅台现在什么价格?" | `get_stock_info` |
| 汇总报告 | "生成本周监控报告" | `generate_report` |

## 🏗️ 架构设计

### 模块结构
```text
agents/
├── api (入口)
│   └── main.py              # 主应用（FastAPI接口）
├── core/
│   ├── __init__.py
│   ├── config.py            # 配置管理（环境变量、工具规格）
│   └── models.py            # 数据模型（Pydantic模型）
├── domain/
│   ├── __init__.py
│   └── strategy.py          # 策略处理（无LLM兜底创建流程）
├── infrastructure/
│   ├── __init__.py
│   └── memory.py            # 内存管理（Redis/内存存储）
└── llm/
    ├── __init__.py
    ├── langchain_integration.py # LangChain集成（ReAct模式）
    ├── llm.py               # LLM处理（通义千问集成）
    └── tools.py             # 工具处理（结果格式化）
```

### ReAct模式
采用Reasoning and Acting模式：
1. **Thought（思考）**: 分析用户意图
2. **Action（行动）**: 选择合适工具
3. **Observation（观察）**: 分析工具结果
4. **Answer（回答）**: 给出最终答案

## 🔧 配置说明

### 环境变量
```bash
# LLM配置（通义千问）
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode
LLM_API_KEY=your_qwen_api_key
LLM_MODEL=qwen3-max

# Redis配置
REDIS_URL=redis://localhost:6379

# 服务配置
AGENTS_PORT=8008
AGENTS_HISTORY_LIMIT=12
```

## 🚀 API接口

### 健康检查
```http
GET /health
```

### 聊天接口
```http
POST /agent/chat
Content-Type: application/json

{
    "message": "帮我监控贵州茅台",
    "user": {"userId": "user123"},
    "toolResults": []
}
```

### 工具列表
```http
GET /tools
```

## 🎯 使用示例

### 1. 创建监控策略
用户输入：`"帮我监控贵州茅台，MACD金叉时提醒我"`

Agent处理：
1. 提取股票代码：sh600519
2. 识别技术指标：MACD金叉
3. 判定工具调用意图为 `create_strategy`
4. 返回给 Node.js 端执行落库并响应最终结果

### 2. 绑定钉钉通知
用户输入：`"帮我绑定钉钉推送"`

Agent处理：
1. 识别订阅类型：dingtalk
2. 判定工具调用意图为 `update_subscription`
3. Node.js 端收到结果后将其落入 SQLite 库，并建立相应的发送通道

## 🔮 未来规划

1. **更多技术指标扩展**: 在 LLM Prompt 层扩展对 RSI、KDJ、布林带等技术指标的识别支持。
2. **智能推荐**: 基于对话历史动态挖掘并主动推荐策略配置。
3. **多语言支持**: 英文、日文等。

## 📊 性能优化

- **架构瘦身**: 剔除了原有的 Celery、PostgreSQL 依赖，启动极速。
- **异步处理**: FastAPI 原生支持异步高并发请求处理。
- **缓存机制**: Redis缓存热点数据和对话历史。

## 🛠️ 开发指南

### 添加新工具
1. 在`core/config.py`的`TOOLS_SPEC`中添加工具定义
2. 在`llm/tools.py`中添加工具调用的格式化逻辑
3. 在`llm/llm.py`的`heuristic_tool_calls`中补充规则兜底逻辑
4. 确保 Node.js 侧 (`server/src/tools/...`) 也同步实现了该工具的具体执行逻辑

---

**兼容性**: Python 3.9+, FastAPI 0.104+
