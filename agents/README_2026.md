# Stock Monitor Agents - 2026升级版

基于2026年技术选型重构的股票监控AI助手，支持8个用户意图和多种通知方式。

## 🚀 核心升级

### 技术栈升级
- **大模型**: 通义千问Qwen3-Max（强函数调用能力）
- **Agent框架**: LangChain 2026 + ReAct模式
- **通知系统**: 钉钉自定义机器人 + 企业微信自建应用
- **记忆存储**: Redis + PostgreSQL架构
- **任务队列**: Celery + Redis（异步任务支持）

### 功能扩展
- ✅ **8个用户意图支持**（原2个扩展到8个）
- ✅ **中文自然语言理解优化**
- ✅ **ReAct模式工具调用**
- ✅ **多渠道通知推送**
- ✅ **模块化架构设计**

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
```
agents/
├── config.py              # 配置管理（环境变量、工具规格）
├── models.py              # 数据模型（Pydantic模型）
├── memory.py              # 内存管理（Redis/内存存储）
├── llm.py                 # LLM处理（通义千问集成）
├── tools.py               # 工具处理（结果格式化）
├── strategy.py            # 策略处理（创建流程）
├── notifications.py       # 通知管理（钉钉/企微）
├── langchain_integration.py # LangChain集成（ReAct模式）
└── main.py                # 主应用（FastAPI接口）
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

### 通义千问配置
支持自动检测DashScope API并配置Qwen3-Max模型，提供更强的中文理解和函数调用能力。

## 📱 通知集成

### 钉钉机器人
```python
# 支持加签验证
notification_manager.register_dingtalk(
    user_id="user123",
    webhook_url="https://oapi.dingtalk.com/robot/send?access_token=xxx",
    secret="your_secret"
)
```

### 企业微信机器人
```python
notification_manager.register_wechat_work(
    user_id="user123",
    webhook_url="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
)
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

### 通知订阅
```http
POST /notifications/subscribe
Content-Type: application/json

{
    "user_id": "user123",
    "notifier_type": "dingtalk",
    "webhook_url": "https://oapi.dingtalk.com/robot/send?access_token=xxx",
    "secret": "your_secret"
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
3. 调用create_strategy工具
4. 返回创建结果

### 2. 查询今日触发
用户输入：`"今天有哪些股票触发了异动？"`

Agent处理：
1. 识别时间范围：today
2. 调用query_triggers工具
3. 格式化触发记录
4. 返回异动列表

### 3. 绑定钉钉通知
用户输入：`"帮我绑定钉钉推送"`

Agent处理：
1. 识别订阅类型：dingtalk
2. 调用update_subscription工具
3. 引导用户提供webhook URL
4. 完成绑定

## 🔮 未来规划

1. **PostgreSQL集成**: 完善持久化存储
2. **Celery任务队列**: 异步长任务处理
3. **更多技术指标**: RSI、KDJ、布林带等
4. **智能推荐**: 基于历史数据的策略推荐
5. **多语言支持**: 英文、日文等

## 📊 性能优化

- **模块化设计**: 降低耦合度，提高可维护性
- **异步处理**: 支持并发请求处理
- **缓存机制**: Redis缓存热点数据
- **连接池**: HTTP客户端连接复用
- **错误处理**: 完善的异常处理和降级机制

## 🛠️ 开发指南

### 添加新工具
1. 在`config.py`的`TOOLS_SPEC`中添加工具定义
2. 在`tools.py`中添加结果格式化逻辑
3. 在`llm.py`的`heuristic_tool_calls`中添加规则
4. 更新相关文档

### 自定义通知器
继承`BaseNotifier`类，实现`send_message`方法：

```python
class CustomNotifier(BaseNotifier):
    async def send_message(self, message: str, msg_type: str = "text"):
        # 实现自定义通知逻辑
        pass
```

---

**升级完成时间**: 2026年3月
**版本**: v2026.1.0
**兼容性**: Python 3.9+, FastAPI 0.104+
