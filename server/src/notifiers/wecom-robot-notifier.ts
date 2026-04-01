import axios from 'axios';

import type { NotifyPayload } from '../notify';

export type WeComRobotNotifierConfig = {
  webhookUrl: string;
  keyword?: string;
};

/**
 * 企业微信群机器人 Webhook 推送。
 * 支持 text/markdown 两种消息类型。
 */
export class WeComRobotNotifier {
  private config: WeComRobotNotifierConfig;

  constructor(config: WeComRobotNotifierConfig) {
    this.config = config;
  }

  async sendMarkdown(markdownText: string): Promise<void> {
    const payload = {
      msgtype: 'markdown',
      markdown: { content: this.prefixKeyword(markdownText) },
    };

    const resp = await axios.post(this.config.webhookUrl, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!resp.data || (resp.data.errcode !== 0 && resp.data.errmsg !== 'ok')) {
      throw new Error(`WeCom Robot API error: ${JSON.stringify(resp.data)}`);
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

    if (!resp.data || (resp.data.errcode !== 0 && resp.data.errmsg !== 'ok')) {
      throw new Error(`WeCom Robot API error: ${JSON.stringify(resp.data)}`);
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
 * 企业微信：技术指标块（用于“指标提醒卡片”）。
 * - 企微 markdown 对表格支持不稳定，这里统一用列表形式输出。
 */
function formatIndicatorBlock(indicator: any): string {
  if (!indicator) return '';

  const macd = indicator.macd;
  const rsi = indicator.rsi;
  const ma = indicator.movingAverages;
  const vol = indicator.volume;

  const parts: string[] = [];
  parts.push('### 📊 技术指标');
  if (macd) parts.push(`- MACD: ${String(macd.trend || '')} (hist: ${safeNum(macd.histogram, 4)})`);
  if (rsi) parts.push(`- RSI(14): ${safeNum(rsi.value, 2)} (${String(rsi.status || '')})`);
  if (vol) {
    const volText = vol.status === 'SURGE'
      ? `放量 x${safeNum(vol.ratio, 2)}`
      : vol.status === 'SHRINK'
        ? `缩量 x${safeNum(vol.ratio, 2)}`
        : `正常 x${safeNum(vol.ratio, 2)}`;
    parts.push(`- 成交量: ${volText} (均值: ${safeNum(vol.averageVolume, 0)})`);
  }
  if (ma) {
    const maTrendText = ma.trend === 'ABOVE_ALL'
      ? '站上全部均线'
      : ma.trend === 'BELOW_ALL'
        ? '跌破全部均线'
        : '均线纠缠';

    const maSignalText = ma.signals
      ? Object.entries(ma.signals)
          .map(([k, v]) => {
            const label = k === 'ma5'
              ? '5日'
              : k === 'ma10'
                ? '10日'
                : k === 'ma20'
                  ? '20日'
                  : k === 'ma60'
                    ? '60日'
                    : k;
            const action = v === 'BREAKOUT' ? '突破' : '跌破';
            return `${action}${label}`;
          })
          .join('，')
      : '';

    parts.push(`- 均线趋势: ${maTrendText}`);
    if (maSignalText) parts.push(`- 均线信号: ${maSignalText}`);
    if (typeof ma.previousClose === 'number') parts.push(`- 上一收盘: ${safeNum(ma.previousClose, 2)}`);
    parts.push(`- MA5: ${safeNum(ma.ma5, 2)}`);
    parts.push(`- MA10: ${safeNum(ma.ma10, 2)}`);
    parts.push(`- MA20: ${safeNum(ma.ma20, 2)}`);
    parts.push(`- MA60: ${safeNum(ma.ma60, 2)}`);
  }
  return parts.join('\n');
}

/**
 * 企业微信：形态信号块（用于“形态信号提醒卡片”）。
 */
function formatPatternBlock(pattern: any): string {
  if (!pattern) return '';
  const direction = pattern.signal === 'BUY' ? '🟢 买入信号' : '🔴 卖出信号';
  return [
    `### ${direction} - ${pattern.type}`,
    `- 参考价位：${safeNum(pattern.previousHigh, 2)}`,
    `- 当前价格：${safeNum(pattern.currentPrice, 2)}`,
    `- 信号强度：${pattern.strength} / 100`,
    `- 解读：${pattern.message}`,
  ].join('\n');
}

/**
 * 企业微信：形态信号提醒卡片。
 * 当事件包含 `ev.snapshot.threshold.pattern` 时命中。
 */
function buildPatternPayload(ev: any): NotifyPayload | null {
  const stock = ev.snapshot?.stock;
  const pattern = ev.snapshot?.threshold?.pattern;
  if (!pattern) return null;

  const symbol = String(ev.symbol || '').toUpperCase();
  const name = ev.stockName || stock?.name || '';
  const timestamp = stock?.timestamp;

  const block = formatPatternBlock(pattern);
  const content = [
    `🔔 形态信号提醒：${name}${symbol}`,
    `> **${name}** (\`${symbol}\`)`,
    '',
    block,
    timestamp ? `- 时间：${timestamp}` : '',
    '',
    '⚠️ 形态信号仅供参考，不构成投资建议',
  ].filter(Boolean);

  return {
    title: `${name} 形态信号: ${pattern.type}`,
    markdown: content.join('\n'),
  };
}

/**
 * 企业微信：指标提醒卡片（MACD/RSI/均线）。
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

  const block = formatIndicatorBlock(indicator);
  const content = [
    `${color} 股票技术面深度分析: ${name}-${ev.reason}`,
    `> **${name}** (\`${symbol}\`)`,
    '',
    `- 现价：**${safeNum(currentPrice, 2)}**`,
    typeof changePercent === 'number' ? `- 涨跌幅：${safeNum(changePercent, 2)}%` : '',
    '',
    `- 触发信号：**${String(ev.reason || '')}**`,
    timestamp ? `- 时间：${timestamp}` : '',
    '',
    block,
    '',
    '⚠️ 技术指标仅供参考，不构成投资建议',
  ].filter(Boolean);

  return {
    title: `${name} 技术分析: ${ev.reason}, 当前股价: ${safeNum(currentPrice, 2)}`,
    markdown: content.join('\n'),
  };
}

/**
 * 企业微信：股票异动提醒卡片（兜底）。
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

  const content = [
    `${color} 股票异动提醒：${name}-${alertType}`,
    `> **${name}** (\`${symbol}\`)`,
    '',
    `- 异动类型：**${alertType}**`,
    `- 当前价：**${safeNum(currentPrice, 2)}**`,
    typeof changePercent === 'number' ? `- 涨跌幅：${safeNum(changePercent, 2)}%` : '',
    typeof changePrice === 'number' ? `- 涨跌额：${safeNum(changePrice, 2)}` : '',
    typeof highPrice === 'number' ? `- 最高价：${safeNum(highPrice, 2)}` : '',
    typeof lowPrice === 'number' ? `- 最低价：${safeNum(lowPrice, 2)}` : '',
    typeof volume === 'number' ? `- 成交量：${(volume / 10000).toFixed(2)} 万手` : '',
    timestamp ? `- 时间：${timestamp}` : '',
    '',
    '⚠️ 股票有风险，数据仅供参考',
  ].filter(Boolean);

  return {
    title: `${name} 异动提醒: ${alertType}, 当前价: ${safeNum(currentPrice, 2)},涨幅：${arrowLocal}${safeNum(changePercent, 2)}%`,
    markdown: content.join('\n'),
  };
}

/**
 * 企业微信卡片分发入口：按事件类型输出三类卡片。
 * 优先级：形态 > 指标 > 异动兜底。
 */
export function buildWeComPayload(ev: any): NotifyPayload {
  const pattern = buildPatternPayload(ev);
  if (pattern) return pattern;

  const indicator = buildIndicatorPayload(ev);
  if (indicator) return indicator;

  return buildStockAlertPayload(ev);
}
