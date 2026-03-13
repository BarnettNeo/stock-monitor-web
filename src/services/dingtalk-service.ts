import axios from 'axios';
import type { StockData } from './stock-api';
import type { PatternSignal } from './stock-pattern';

interface DingTalkConfig {
  webhookUrl: string;
  keyword: string;
}

interface DingTalkMessage {
  msgtype: 'text' | 'markdown';
  text?: { content: string };
  markdown?: { title: string; text: string };
}

export class DingTalkService {
  private config: DingTalkConfig;

  constructor(config: DingTalkConfig) {
    this.config = config;
  }

  // 发送股票异动提醒
  async sendStockAlert(stock: StockData, alertType: string): Promise<boolean> {
    const color = stock.changePercent >= 0 ? '🔴' : '🟢';
    const arrow = stock.changePercent >= 0 ? '↑' : '↓';

    const content = `### ${color} 股票异动提醒, ${alertType}

> **${stock.name}** (\`${stock.code}\`)

| 指标 | 数值 |
|------|------|
| 当前价 | **${stock.currentPrice.toFixed(2)}** 元 |
| 涨跌幅 | ${arrow} **${Math.abs(stock.changePercent).toFixed(2)}%** |
| 涨跌额 | ${arrow} **${Math.abs(stock.changePrice).toFixed(2)}** 元 |
| 最高价 | ${stock.highPrice.toFixed(2)} 元 |
| 最低价 | ${stock.lowPrice.toFixed(2)} 元 |
| 成交量 | ${(stock.volume / 10000).toFixed(2)} 万手 |

📊 异动类型：**${alertType}** \n
⏰ 时间：${stock.timestamp}

---
⚠️ 股票有风险，数据仅供参考`;

    return this.sendMessage({
      msgtype: 'markdown',
      markdown: {
        title: `${stock.name} 异动提醒, ${alertType}, 当前价：${stock.currentPrice.toFixed(2)},涨幅：${arrow}${Math.abs(stock.changePercent).toFixed(2)}%`,
        text: content,
      },
    });
  }

  // 发送文本消息
  async sendTextMessage(content: string): Promise<boolean> {
    const safeContent = content.includes(this.config.keyword)
      ? content
      : `${this.config.keyword}：${content}`;

    return this.sendMessage({
      msgtype: 'text',
      text: { content: safeContent },
    });
  }

  // 发送指标提醒
  async sendIndicatorAlert(
    data: import('./indicator-service').IndicatorResult,
    signalType: string,
  ): Promise<boolean> {
    const colorEmoji = data.currentPrice >= data.movingAverages.ma20 ? '🟢' : '🔴';

    const macdText =
      data.macd.trend === 'BULLISH'
        ? '✨ 金叉 (看涨)'
        : data.macd.trend === 'BEARISH'
        ? '💀 死叉 (看跌)'
        : '➖ 震荡';

    const rsiText =
      data.rsi.status === 'OVERBOUGHT'
        ? '🔥 超买 (风险)'
        : data.rsi.status === 'OVERSOLD'
        ? '💎 超卖 (机会)'
        : '⚖️ 正常';

    const content = `## ${this.config.keyword} ${colorEmoji} 技术面深度分析

> **${data.name}** (\`${data.code}\`) 现价：**${data.currentPrice}**

### 📊 核心指标
| 指标 | 数值/状态 | 解读 |
|------|-----------|------|
| **MACD** | ${macdText} | 柱: ${data.macd.histogram} |
| **RSI(14)** | ${data.rsi.value} (${rsiText}) | 强弱指标 |
| **均线趋势** | ${data.movingAverages.trend} | 站上了所有均线 |

### 📏 均线系统
- MA5: ${data.movingAverages.ma5}
- MA10: ${data.movingAverages.ma10}
- MA20: ${data.movingAverages.ma20}
- MA60: ${data.movingAverages.ma60}

🚀 **触发信号**: ${signalType} \n
⏰ 时间：${data.timestamp}

---
⚠️ 技术指标仅供参考，不构成投资建议`;

    return this.sendMessage({
      msgtype: 'markdown',
      markdown: {
        title: `${this.config.keyword} - ${data.name} 技术分析: ${signalType}`,
        text: content,
      },
    });
  }

  // 发送形态信号提醒
  async sendPatternAlert(
    stock: StockData,
    pattern: PatternSignal,
  ): Promise<boolean> {
    const direction =
      pattern.signal === 'BUY' ? '🟢 买入信号' : '🔴 卖出信号';

    const content = `### ${direction} - ${pattern.type}

> **${stock.name}** (\`${stock.code}\`)

| 指标 | 数值 |
|------|------|
| 形态名称 | ${pattern.type} |
| 前${pattern.signal === 'BUY' ? '高' : '低'}价位 | ${pattern.previousHigh.toFixed(2)} |
| 当前价格 | ${pattern.currentPrice.toFixed(2)} |
| 信号强度 | ${pattern.strength} / 100 |

📊 形态解读：**${pattern.message}** \n
⏰ 时间：${stock.timestamp}

---
⚠️ 形态信号仅供参考，不构成投资建议`;

    return this.sendMessage({
      msgtype: 'markdown',
      markdown: {
        title: `${stock.name} 股票形态信号: ${pattern.type} (${direction})`,
        text: content,
      },
    });
  }

  private async sendMessage(payload: DingTalkMessage): Promise<boolean> {
    try {
      const response = await axios.post(this.config.webhookUrl, payload, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.data.errcode === 0) {
        console.log('✅ 钉钉消息发送成功');
        return true;
      } else {
        console.error('❌ 钉钉 API 错误:', response.data);
        return false;
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error('❌ 发送消息失败:', error.message);
      }
      return false;
    }
  }
}

