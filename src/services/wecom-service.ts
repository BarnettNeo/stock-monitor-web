import axios from 'axios';
import type { StockData } from './stock-api';
import type { PatternSignal } from './stock-pattern';

interface WeComConfig {
  webhookUrl: string;
  keyword?: string;
}

interface WeComTextMessage {
  msgtype: 'text';
  text: { content: string };
}

interface WeComMarkdownMessage {
  msgtype: 'markdown';
  markdown: { content: string };
}

type WeComMessage = WeComTextMessage | WeComMarkdownMessage;

export class WeComService {
  private config: WeComConfig;

  constructor(config: WeComConfig) {
    this.config = config;
  }

  // 发送股票异动提醒
  async sendStockAlert(stock: StockData, alertType: string): Promise<boolean> {
    const color = stock.changePercent >= 0 ? '🔴' : '🟢';
    const arrow = stock.changePercent >= 0 ? '↑' : '↓';

    const title = `${color} 股票异动提醒, ${alertType}`;

    const content = `${this.prefixKeyword(title)}\n\n` +
      `> **${stock.name}** (\`${stock.code}\`)\n\n` +
      `- 当前价：**${stock.currentPrice.toFixed(2)}** 元\n` +
      `- 涨跌幅：${arrow} **${Math.abs(stock.changePercent).toFixed(2)}%**\n` +
      `- 涨跌额：${arrow} **${Math.abs(stock.changePrice).toFixed(2)}** 元\n` +
      `- 最高价：${stock.highPrice.toFixed(2)} 元\n` +
      `- 最低价：${stock.lowPrice.toFixed(2)} 元\n` +
      `- 成交量：${(stock.volume / 10000).toFixed(2)} 万手\n\n` +
      `📊 异动类型：**${alertType}**\n` +
      `⏰ 时间：${stock.timestamp}\n\n` +
      `⚠️ 股票有风险，数据仅供参考`;

    return this.sendMessage({
      msgtype: 'markdown',
      markdown: { content },
    });
  }

  // 发送文本消息
  async sendTextMessage(content: string): Promise<boolean> {
    return this.sendMessage({
      msgtype: 'text',
      text: { content: this.prefixKeyword(content) },
    });
  }

  // 发送技术面深度分析
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

    const title = `${colorEmoji} 技术面深度分析 - ${data.name} ${signalType}`;

    const content = `${this.prefixKeyword(title)}\n\n` +
      `> **${data.name}** (\`${data.code}\`) 现价：**${data.currentPrice}**\n\n` +
      `### 📊 核心指标\n` +
      `- **MACD**：${macdText}（柱: ${data.macd.histogram}）\n` +
      `- **RSI(14)**：${data.rsi.value}（${rsiText}）\n` +
      `- **均线趋势**：${data.movingAverages.trend}\n\n` +
      `### 📏 均线系统\n` +
      `- MA5: ${data.movingAverages.ma5}\n` +
      `- MA10: ${data.movingAverages.ma10}\n` +
      `- MA20: ${data.movingAverages.ma20}\n` +
      `- MA60: ${data.movingAverages.ma60}\n\n` +
      `🚀 **触发信号**：${signalType}\n` +
      `⏰ 时间：${data.timestamp}\n\n` +
      `⚠️ 技术指标仅供参考，不构成投资建议`;

    return this.sendMessage({
      msgtype: 'markdown',
      markdown: { content },
    });
  }

  // 发送形态学信号
  async sendPatternAlert(stock: StockData, pattern: PatternSignal): Promise<boolean> {
    const direction = pattern.signal === 'BUY' ? '🟢 买入信号' : '🔴 卖出信号';
    const title = `${direction} - ${pattern.type}`;

    const content = `${this.prefixKeyword(title)}\n\n` +
      `> **${stock.name}** (\`${stock.code}\`)\n\n` +
      `- 形态名称：${pattern.type}\n` +
      `- 前${pattern.signal === 'BUY' ? '高' : '低'}价位：${pattern.previousHigh.toFixed(2)}\n` +
      `- 当前价格：${pattern.currentPrice.toFixed(2)}\n` +
      `- 信号强度：${pattern.strength} / 100\n\n` +
      `📊 形态解读：**${pattern.message}**\n` +
      `⏰ 时间：${stock.timestamp}\n\n` +
      `⚠️ 形态信号仅供参考，不构成投资建议`;

    return this.sendMessage({
      msgtype: 'markdown',
      markdown: { content },
    });
  }

  private prefixKeyword(content: string): string {
    if (!this.config.keyword) return content;
    return content.includes(this.config.keyword) ? content : `${this.config.keyword}：${content}`;
  }

  private async sendMessage(payload: WeComMessage): Promise<boolean> {
    try {
      const response = await axios.post(this.config.webhookUrl, payload, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.data && (response.data.errcode === 0 || response.data.errmsg === 'ok')) {
        console.log('✅ 企业微信消息发送成功');
        return true;
      }

      console.error('❌ 企业微信 API 错误:', response.data);
      return false;
    } catch (error) {
      if (error instanceof Error) {
        console.error('❌ 发送消息失败:', error.message);
      }
      return false;
    }
  }
}
