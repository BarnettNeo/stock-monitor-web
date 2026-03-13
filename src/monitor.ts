import 'dotenv/config';
import { stockApiService, type StockData } from './services/stock-api';
import { DingTalkService } from './services/dingtalk-service';
import { WeComService } from './services/wecom-service';
import { indicatorService, type IndicatorResult, getRecentPriceData } from './services/indicator-service';
import { detectBreakoutPullback, type PatternSignal } from './services/stock-pattern';

interface StrategyConfig {
  priceAlertPercent: number;
  enableMacdGoldenCross: boolean;
  enableRsiOversold: boolean;
  enableRsiOverbought: boolean;
  enableMovingAverages?: boolean;
  enablePatternSignal?: boolean;
  alertCooldownMinutes: number;
  targetPricesUp?: Record<string, number>;
  targetPricesDown?: Record<string, number>;
}

interface GroupConfig {
  id: string;
  name: string;
  enabled?: boolean;
  marketTimeOnly?: boolean;
  pushType?: 'dingtalk' | 'wecom' | 'both';
  webhook: string;
  keyword: string;
  wecomWebhook?: string;
  wecomKeyword?: string;
  stocks: string[];
  strategy: StrategyConfig;
  checkIntervalMs: number;
}

interface RootConfig {
  globalInterval: number;
  groups: GroupConfig[];
}

const CONFIG = require('../config') as RootConfig;

type AlertNotifier = {
  // 发送股票异动提醒
  sendStockAlert: (stock: StockData, alertType: string) => Promise<boolean>;
  // 发送技术面深度分析
  sendIndicatorAlert: (
    data: IndicatorResult,
    signalType: string,
  ) => Promise<boolean>;
  // 发送形态学信号
  sendPatternAlert: (
    stock: StockData,
    pattern: PatternSignal,
  ) => Promise<boolean>;
  // 发送文本消息
  sendTextMessage: (content: string) => Promise<boolean>;
};

class GroupMonitor {
  private config: GroupConfig;
  private notifiers: AlertNotifier[];
  private alertedSignals: Map<string, number> = new Map();

  constructor(config: GroupConfig) {
    this.config = config;
    this.notifiers = [];

    const pushType = config.pushType || 'dingtalk';
    // 钉钉推送
    if (pushType === 'dingtalk' || pushType === 'both') {
      this.notifiers.push(
        new DingTalkService({
          webhookUrl: config.webhook,
          keyword: config.keyword,
        }),
      );
    }

    // 企业微信推送
    if (pushType === 'wecom' || pushType === 'both') {
      if (config.wecomWebhook) {
        this.notifiers.push(
          new WeComService({
            webhookUrl: config.wecomWebhook,
            keyword: config.wecomKeyword || config.keyword,
          }),
        );
      } else {
        console.warn(
          `⚠️ 群组 ${config.name} (${config.id}) 配置 pushType=${pushType} 但未提供 wecomWebhook，已跳过企业微信推送`,
        );
      }
    }
  }

  private isMarketOpen(): boolean {
    const now = new Date();
    const day = now.getDay();

    if (day === 0 || day === 6) {
      return false;
    }

    const hour = now.getHours();
    const minute = now.getMinutes();
    const totalMinutes = hour * 60 + minute;

    const inMorning = totalMinutes >= 9 * 60 + 30 && totalMinutes <= 11 * 60 + 30;
    const inAfternoon = totalMinutes >= 13 * 60 && totalMinutes <= 15 * 60;

    return inMorning || inAfternoon;
  }

  private checkAlert(stock: StockData): string | null {
    if (stock.changePercent >= this.config.strategy.priceAlertPercent) {
      return `涨幅超标 (+${stock.changePercent}%)`;
    }
    if (stock.changePercent <= -this.config.strategy.priceAlertPercent) {
      return `跌幅超标 (-${Math.abs(stock.changePercent)}%)`;
    }
    return null;
  }

  private checkIndicatorSignals(indicator: IndicatorResult): string[] {
    const rules = [
      {
        enabled: this.config.strategy.enableMacdGoldenCross,
        matched: indicator.macd.trend === 'BULLISH',
        message: 'MACD 金叉 (买入信号)',
      },
      {
        enabled: this.config.strategy.enableRsiOversold,
        matched: indicator.rsi.status === 'OVERSOLD',
        message: 'RSI 超卖 (潜在反弹)',
      },
      {
        enabled: this.config.strategy.enableRsiOverbought,
        matched: indicator.rsi.status === 'OVERBOUGHT',
        message: 'RSI 超买 (回调风险)',
      },
      {
        enabled: this.config.strategy.enableMovingAverages,
        matched: indicator.movingAverages.trend === 'ABOVE_ALL',
        message: '均线多头排列 (趋势偏多)',
      },
    ];

    return rules.filter(rule => rule.enabled && rule.matched).map(rule => rule.message);
  }

  async checkOnce(): Promise<void> {
    if (this.config.marketTimeOnly !== false && !this.isMarketOpen()) {
      console.log(
        `⏸ 当前不在交易时间，跳过本次扫描: ${this.config.name} (${this.config.id})`,
      );
      console.log('---');
      return;
    }

    console.log(
      `\n🔍 [${new Date().toLocaleString('zh-CN')}] 开始深度扫描... 群组: ${this.config.name}`,
    );

    const stocks = await stockApiService.getStockDataBatch([...this.config.stocks]);

    for (const stock of stocks) {
      let alertTriggered = false;
      let alertReason = '';

      const codeKey = stock.code.toLowerCase();
      const targetPriceUp =
        this.config.strategy.targetPricesUp &&
        this.config.strategy.targetPricesUp[codeKey];
      const targetPriceDown =
        this.config.strategy.targetPricesDown &&
        this.config.strategy.targetPricesDown[codeKey];

      // 检查目标价触发（上行）
      if (
        typeof targetPriceUp === 'number' &&
        targetPriceUp > 0 &&
        stock.currentPrice >= targetPriceUp
      ) {
        alertTriggered = true;
        alertReason = `涨幅至目标价: ${targetPriceUp}`;
        const color = stock.changePercent >= 0 ? '🔴' : '🟢';
        const arrow = stock.changePercent >= 0 ? '↑' : '↓';
        console.log('---');
        console.log(
          `${color} ${stock.name} 涨幅至目标价提醒, 当前价：${stock.currentPrice.toFixed(
            2,
          )}, 涨幅至目标价：${targetPriceUp}, 涨幅：${arrow}${Math.abs(
            stock.changePercent,
          ).toFixed(2)}%`,
        );
        for (const notifier of this.notifiers) {
          await notifier.sendStockAlert(stock, alertReason);
        }
      }
      // 检查目标价触发（下行）
      else if (
        typeof targetPriceDown === 'number' &&
        targetPriceDown > 0 &&
        stock.currentPrice <= targetPriceDown
      ) {
        alertTriggered = true;
        alertReason = `跌幅至目标价: ${targetPriceDown}`;
        const color = stock.changePercent >= 0 ? '🔴' : '🟢';
        const arrow = stock.changePercent >= 0 ? '↑' : '↓';
        console.log('---');
        console.log(
          `${color} ${stock.name} 跌幅至目标价提醒, 当前价：${stock.currentPrice.toFixed(
            2,
          )}, 跌幅至目标价：${targetPriceDown}, 涨跌幅：${arrow}${Math.abs(
            stock.changePercent,
          ).toFixed(2)}%`,
        );
        for (const notifier of this.notifiers) {
          await notifier.sendStockAlert(stock, alertReason);
        }
      }

      // 检查价格异动
      else if (
        !targetPriceUp && !targetPriceDown && Math.abs(stock.changePercent) >= this.config.strategy.priceAlertPercent
      ) {
        alertTriggered = true;
        alertReason = `价格异动 (${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent}%)`;
        const color = stock.changePercent >= 0 ? '🔴' : '🟢';
        const arrow = stock.changePercent >= 0 ? '↑' : '↓';
        console.log('---');
        console.log(
          `${color} ${stock.name} 异动提醒, 当前价：${stock.currentPrice.toFixed(
            2,
          )},涨幅：${arrow}${Math.abs(stock.changePercent).toFixed(2)}%`,
        );
        for (const notifier of this.notifiers) {
          await notifier.sendStockAlert(stock, alertReason);
        }
      }

      if (
        this.config.strategy.enableMacdGoldenCross ||
        this.config.strategy.enableRsiOversold ||
        this.config.strategy.enableRsiOverbought ||
        this.config.strategy.enableMovingAverages
      ) {
        const indicator = await indicatorService.calculateIndicators(
          stock.code,
          stock.name,
          stock.currentPrice,
        );

        if (indicator) {
          const signals = this.checkIndicatorSignals(indicator);
          for (const signal of signals) {
            console.log('---');
            console.log(`🔍 ${stock.name}${stock.code}指标计算完成，检查信号 ${signal}`);
            const signalKey = `${stock.code}-${signal}`;
            const lastAlertTime = this.alertedSignals.get(signalKey) || 0;
            const now = Date.now();
            console.log(
              `🔍 检查信号 ${signalKey}: 上次提醒时间：${lastAlertTime}, 当前时间：${stock.timestamp}`,
            );

            if (
              now - lastAlertTime >
              this.config.strategy.alertCooldownMinutes * 60 * 1000
            ) {
              console.log(`🚨 触发技术信号：${stock.name} - ${signal}`);
              for (const notifier of this.notifiers) {
                await notifier.sendIndicatorAlert(indicator, signal);
              }

              this.alertedSignals.set(signalKey, now);
              alertTriggered = true;
            }
          }
        }
      }

      // 检查形态信号
      if (this.config.strategy.enablePatternSignal) {
        const prices = await getRecentPriceData(stock.code);
        if (prices.length > 0) {
          // console.log(`🔍 ${stock.name}${stock.code} 最近240条价格数据获取成功，共 ${prices.length} 条`);
          const pattern = detectBreakoutPullback(prices);
          if (pattern) {
            const patternKey = `${stock.code}-PATTERN-${pattern.type}-${pattern.signal}`;
            const lastPatternTime = this.alertedSignals.get(patternKey) || 0;
            const now = Date.now();
            console.log(
              `🔍 检查形态信号 ${patternKey}: 上次提醒时间：${lastPatternTime}, 当前时间：${stock.timestamp}`,
            );
            
            if (
              now - lastPatternTime >
              this.config.strategy.alertCooldownMinutes * 60 * 1000
            ) {
              for (const notifier of this.notifiers) {
                await notifier.sendPatternAlert(stock, pattern);
              }
              this.alertedSignals.set(patternKey, now);
              alertTriggered = true;
            }
          }
        }
      }

      if (!alertTriggered) {
        console.log(`✅ ${stock.name}${stock.code}: 无显著异动, 当前价：${stock.currentPrice.toFixed(2)}，涨幅：${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent.toFixed(2)}%`);
      }
    }
  }

  start(): void {
    console.log(`🚀 股票监控系统启动：${this.config.name}`);
    console.log(`📋 监控股票数量：${this.config.stocks.length}`);
    console.log(`⏱️ 检查间隔：${this.config.checkIntervalMs / 1000} 秒`);
    console.log(`🔔 异动阈值：±${this.config.strategy.priceAlertPercent}%`);
    console.log('---');

    this.checkOnce();

    setInterval(() => {
      this.checkOnce();
    }, this.config.checkIntervalMs);
  }
}

class StockMonitor {
  private groups: GroupMonitor[];

  constructor() {
    this.groups = CONFIG.groups
      .filter(groupConfig => groupConfig.enabled !== false)
      .map(groupConfig => new GroupMonitor(groupConfig));
  }

  start(): void {
    for (const groupMonitor of this.groups) {
      groupMonitor.start();
    }
  }
}

const monitor = new StockMonitor();
monitor.start();

