import axios from 'axios';

import type { NotifyPayload } from '../notify';

export type DingTalkNotifierConfig = {
  webhookUrl: string;
  keyword?: string;
};

/**
 * 钉钉群机器人 Webhook 推送。
 * 兼容项目原有的“关键词”要求（若消息未包含关键词会自动前缀）。
 */
export class DingTalkNotifier {
  private config: DingTalkNotifierConfig;

  constructor(config: DingTalkNotifierConfig) {
    this.config = config;
  }

  async sendMarkdown(title: string, markdownText: string): Promise<void> {
    const safeTitle = this.prefixKeyword(title);
    const safeText = this.prefixKeyword(markdownText);

    const payload = {
      msgtype: 'markdown',
      markdown: {
        title: safeTitle,
        text: safeText,
      },
    };

    const resp = await axios.post(this.config.webhookUrl, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!resp.data || resp.data.errcode !== 0) {
      throw new Error(`DingTalk API error: ${JSON.stringify(resp.data)}`);
    }
  }

  async sendText(content: string): Promise<void> {
    const payload = {
      msgtype: 'text',
      text: { content: this.prefixKeyword(content) },
    };

    const resp = await axios.post(this.config.webhookUrl, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!resp.data || resp.data.errcode !== 0) {
      throw new Error(`DingTalk API error: ${JSON.stringify(resp.data)}`);
    }
  }

  private prefixKeyword(content: string): string {
    if (!this.config.keyword) return content;
    return content.includes(this.config.keyword)
      ? content
      : `### ${this.config.keyword}${content}`;
  }
}

/**
 * 数值安全格式化：非 number / NaN 时返回空串，避免推送里出现 "NaN"。
 */
function safeNum(v: any, fixed: number = 2): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '';
  return v.toFixed(fixed);
}

/**
 * 钉钉：技术指标块（用于“指标提醒卡片”）。
 * - 钉钉支持 markdown 表格，这里采用“核心指标表格 + 均线系统列表”的旧版展示。
 */
function formatIndicatorBlock(indicator: any): string {
  if (!indicator) return '';

  const macd = indicator.macd;
  const rsi = indicator.rsi;
  const ma = indicator.movingAverages;

  const macdText = macd
    ? macd.trend === 'BULLISH'
      ? '✨ 金叉 (看涨)'
      : macd.trend === 'BEARISH'
        ? '💀 死叉 (看跌)'
        : '➖ 震荡'
    : '';

  const rsiText = rsi
    ? rsi.status === 'OVERBOUGHT'
      ? '🔥 超买 (风险)'
      : rsi.status === 'OVERSOLD'
        ? '💎 超卖 (机会)'
        : '⚖️ 正常'
    : '';

  const maText = ma ? String(ma.trend || '') : '';

  const lines: string[] = [];
  lines.push('### 📊  核心指标');
  lines.push('| 指标 | 数值/状态 | 解读 |');
  lines.push('|------|-----------|------|');
  if (macd) lines.push(`| **MACD** | ${macdText} | 柱: ${safeNum(macd.histogram, 4)} |`);
  if (rsi) lines.push(`| **RSI(14)** | ${safeNum(rsi.value, 2)} (${rsiText}) | 强弱指标 |`);
  if (ma) lines.push(`| **均线趋势** | ${maText} | 站上了所有均线 |`);

  if (ma) {
    lines.push('');
    lines.push('### 均线系统');
    lines.push(`- MA5: ${safeNum(ma.ma5, 2)}`);
    lines.push(`- MA10: ${safeNum(ma.ma10, 2)}`);
    lines.push(`- MA20: ${safeNum(ma.ma20, 2)}`);
    lines.push(`- MA60: ${safeNum(ma.ma60, 2)}`);
  }

  return lines.join('\n');
}

/**
 * 钉钉：形态信号提醒卡片。
 * 当事件包含 `ev.snapshot.threshold.pattern` 时命中。
 */
function buildPatternPayload(ev: any): NotifyPayload | null {
  const stock = ev.snapshot?.stock;
  const pattern = ev.snapshot?.threshold?.pattern;
  if (!pattern) return null;

  const symbol = String(ev.symbol || '').toUpperCase();
  const name = ev.stockName || stock?.name || '';
  const timestamp = stock?.timestamp;
  const direction = pattern.signal === 'BUY' ? '🟢 买入信号' : '🔴 卖出信号';

  const content = [
    `${direction} - ${pattern.type}`,
    '',
    `> **${name}** (\`${symbol}\`)`,
    '',
    '| 指标 | 数值 |',
    '|------|------|',
    `| 形态名称 | ${pattern.type} |`,
    `| 前${pattern.signal === 'BUY' ? '高' : '低'}价位 | ${safeNum(pattern.previousHigh, 2)} |`,
    `| 当前价格 | ${safeNum(pattern.currentPrice, 2)} |`,
    `| 信号强度 | ${pattern.strength} / 100 |`,
    '',
    `📊 形态解读：**${pattern.message}** \n`,
    timestamp ? `⏰ 时间：${timestamp}` : '',
    '',
    '---',
    '⚠️ 形态信号仅供参考，不构成投资建议',
  ].filter(Boolean);

  return {
    title: `${name} 股票形态信号: ${pattern.type} (${direction})`,
    markdown: content.join('\n'),
  };
}

/**
 * 钉钉：指标提醒卡片（MACD/RSI/均线）。
 * 当事件包含 `ev.snapshot.indicator` 且 reason 非“价格异动”类时命中。
 */
function buildIndicatorPayload(ev: any): NotifyPayload | null {
  const stock = ev.snapshot?.stock;
  const indicator = ev.snapshot?.indicator;
  if (!indicator) return null;

  if (typeof ev.reason === 'string' && ev.reason.includes('价格异动')) return null;

  const symbol = String(ev.symbol || '').toUpperCase();
  const name = ev.stockName || stock?.name || '';
  const currentPrice = stock?.currentPrice;
  const changePercent = stock?.changePercent;
  const timestamp = stock?.timestamp;
  const color = typeof changePercent === 'number' && changePercent >= 0 ? '🔴' : '🟢';

  const indicatorBlock = formatIndicatorBlock(indicator);
  const content = [
    `${color} 股票技术面深度分析: ${name}-${ev.reason}`,
    '',
    `> **${name}** (\`${symbol}\`) 现价：**${safeNum(currentPrice, 2)}**`,
    '',
    indicatorBlock,
    '\n',
    `🚀 **触发信号**: ${ev.reason} \n`,
    timestamp ? `⏰ 时间：${timestamp}` : '',
    '--------------------------------------',
    '⚠️ 技术指标仅供参考，不构成投资建议',
  ].filter(Boolean);

  return {
    title: `${name} 技术分析: ${ev.reason}, 当前股价: ${safeNum(currentPrice, 2)}`,
    markdown: content.join('\n'),
  };
}

/**
 * 钉钉：股票异动提醒卡片（兜底）。
 * 用于“价格异动/目标价触达”等非指标、非形态的推送。
 */
function buildStockAlertPayload(ev: any): NotifyPayload {
  const stock = ev.snapshot?.stock;
  const symbol = String(ev.symbol || '').toUpperCase();
  const name = ev.stockName || stock?.name || '';
  const currentPrice = stock?.currentPrice;
  const changePercent = stock?.changePercent;
  const changePrice = stock?.changePrice;
  const highPrice = stock?.highPrice;
  const lowPrice = stock?.lowPrice;
  const volume = stock?.volume;
  const timestamp = stock?.timestamp;

  const color = typeof changePercent === 'number' && changePercent >= 0 ? '🔴' : '🟢';
  const arrowLocal = typeof changePercent === 'number' && changePercent >= 0 ? '↑' : '↓';
  const alertType = String(ev.reason || '股票异动');

const content = `### ${color} 股票异动提醒：${name}-${alertType}

> **${name}** (\`${symbol}\`)

| 指标 | 数值 |
|------|------|
| 当前价 | **${safeNum(currentPrice, 2)}** 元 |
| 涨跌幅 | ${arrowLocal} **${safeNum(Math.abs(changePercent), 2)}%** |
| 涨跌额 | ${arrowLocal} **${safeNum(Math.abs(changePrice), 2)}** 元 |
| 最高价 | ${safeNum(highPrice, 2)} 元 |
| 最低价 | ${safeNum(lowPrice, 2)} 元 |
| 成交量 | ${(volume / 10000).toFixed(2)} 万手 |

📊 异动类型：**${alertType}** \n
⏰ 时间：${timestamp}

---
⚠️ 股票有风险，数据仅供参考`;

  return {
    title: `${name} 异动提醒, ${alertType}, 当前价：${safeNum(currentPrice, 2)},涨幅：${arrowLocal}${safeNum(Math.abs(changePercent), 2)}%`,
    markdown: content,
  };
}

/**
 * 钉钉卡片分发入口：按事件类型输出三类卡片。
 * 优先级：形态 > 指标 > 异动兜底。
 */
export function buildDingTalkPayload(ev: any): NotifyPayload {
  const pattern = buildPatternPayload(ev);
  if (pattern) return pattern;

  const indicator = buildIndicatorPayload(ev);
  if (indicator) return indicator;

  return buildStockAlertPayload(ev);
}
