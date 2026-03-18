import axios from 'axios';
import iconv from 'iconv-lite';
import { MACD, RSI, SMA } from 'technicalindicators';
import { detectBreakoutPullback, type PatternSignal, type PriceData } from './pattern';

export type Strategy = {
  id: string;
  userId?: string | null;
  name: string;
  enabled: boolean;
  symbols: string[];
  marketTimeOnly?: boolean;
  /**
   * 报警模式（二选一）：
   * - percent：大幅异动监控（使用 priceAlertPercent）
   * - target：目标价触发（使用 targetPriceUp/targetPriceDown）
   */
  alertMode?: 'percent' | 'target';
  /**
   * 目标价触发（可选）：
   * - 上行：currentPrice >= targetPriceUp
   * - 下行：currentPrice <= targetPriceDown
   */
  targetPriceUp?: number;
  targetPriceDown?: number;
  /**
   * 该策略关联的订阅 ID 列表。
   * - 空数组表示：只记录触发日志，不执行推送。
   */
  subscriptionIds?: string[];
  intervalMs: number;
  cooldownMinutes: number;
  priceAlertPercent: number;
  enableMacdGoldenCross: boolean;
  enableRsiOversold: boolean;
  enableRsiOverbought: boolean;
  enableMovingAverages: boolean;
  enablePatternSignal: boolean;
};

export type StockData = {
  code: string;
  name: string;
  currentPrice: number;
  openPrice: number;
  closePrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  amount: number;
  changePercent: number;
  changePrice: number;
  timestamp: string;
};

export type IndicatorSnapshot = {
  macd?: {
    macdLine: number;
    signalLine: number;
    histogram: number;
    trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  };
  rsi?: {
    value: number;
    status: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
  };
  movingAverages?: {
    ma5: number;
    ma10: number;
    ma20: number;
    ma60: number;
    trend: 'ABOVE_ALL' | 'BELOW_ALL' | 'MIXED';
  };
};

export type TriggerEvent = {
  symbol: string;
  stockName?: string;
  reason: string;
  snapshot: {
    stock: StockData;
    indicator?: IndicatorSnapshot;
    threshold?: any;
  };
};

const lastAlertSentAt = new Map<string, number>();
const lastIndicatorSentAt = new Map<string, number>();

function isMarketOpen(): boolean {
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

// 批量获取股票数据
export async function fetchStockDataBatch(codes: string[]): Promise<StockData[]> {
  const baseURL = 'https://hq.sinajs.cn/rn=' + Date.now();
  const codeList = codes.join(',');

  const response = await axios.get(`${baseURL}&list=${codeList}`, {
    timeout: 10000,
    responseType: 'arraybuffer',
    headers: {
      Referer: 'https://finance.sina.com.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  const decoded = iconv.decode(Buffer.from(response.data), 'gbk');
  const lines = decoded.split('\n').filter(line => line.trim());

  const results: StockData[] = [];

  for (const line of lines) {
    const match = line.match(/var hq_str_([\w]+)="(.+)"/);
    if (!match || !match[2]) continue;

    const code = match[1].toUpperCase();
    const fields = match[2].split(',');
    if (fields.length < 30 || fields[0] === '') continue;

    const currentPrice = parseFloat(fields[3]) || 0;
    const closePrice = parseFloat(fields[2]) || 0;
    const changePercent = closePrice > 0 ? ((currentPrice - closePrice) / closePrice) * 100 : 0;

    results.push({
      code,
      name: fields[0],
      currentPrice,
      openPrice: parseFloat(fields[1]) || 0,
      closePrice,
      highPrice: parseFloat(fields[4]) || 0,
      lowPrice: parseFloat(fields[5]) || 0,
      volume: parseFloat(fields[8]) || 0,
      amount: parseFloat(fields[9]) || 0,
      changePercent: Number(changePercent.toFixed(2)),
      changePrice: Number((currentPrice - closePrice).toFixed(2)),
      timestamp: new Date().toLocaleString('zh-CN'),
    });
  }

  return results;
}

// 获取历史收盘价
async function fetchHistoryCloses(code: string, period: string = '1'): Promise<number[]> {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${code}&scale=${period}&datalen=240`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://finance.sina.com.cn/',
    },
  });

  const klines = response.data;
  if (!Array.isArray(klines) || klines.length === 0) return [];

  const closes = klines.map((k: any) => parseFloat(k.close));
  return closes.filter((c: number) => !isNaN(c));
}

// 获取最近价格数据的内部实现函数
export async function fetchKLineData(code: string, scale: string = '1', datalen: number = 240): Promise<PriceData[]> {
  const safeLen = Math.max(1, Math.min(500, Number(datalen) || 240));
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${code}&scale=${scale}&datalen=${safeLen}`;
  const response = await axios.get(url, {
    timeout: 5000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://finance.sina.com.cn/',
    },
  });

  const klines = response.data;
  if (!Array.isArray(klines) || klines.length === 0) return [];

  const prices: PriceData[] = klines
    .map((k: any) => {
      const open = parseFloat(k.open);
      const high = parseFloat(k.high);
      const low = parseFloat(k.low);
      const close = parseFloat(k.close);
      const volume = k.volume !== undefined ? Number(k.volume) : Number(k.vol || 0);

      if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) return null;

      return {
        open,
        high,
        low,
        close,
        volume: isNaN(volume) ? 0 : volume,
        time: k.day || k.date || '',
      } as PriceData;
    })
    .filter((p: PriceData | null): p is PriceData => p !== null);

  return prices;
}

// 获取最近价格数据的内部实现函数
export async function fetchRecentPriceData(code: string, period: string = '1'): Promise<PriceData[]> {
  return fetchKLineData(code, period, 240);
}

// 计算指标快照
export async function calculateIndicatorSnapshot(
  code: string,
  currentPrice: number,
): Promise<IndicatorSnapshot | null> {
  const closes = await fetchHistoryCloses(code, '1');
  if (closes.length < 60) return null;

  const macdInput: any = {
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  };

  const macdResult: any[] = MACD.calculate(macdInput) || [];
  if (macdResult.length < 2) return null;

  const lastMacd: any = macdResult[macdResult.length - 1];
  const prevMacd: any = macdResult[macdResult.length - 2];

  let macdTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (lastMacd.MACD > lastMacd.signal && prevMacd.MACD <= prevMacd.signal) macdTrend = 'BULLISH';
  else if (lastMacd.MACD < lastMacd.signal && prevMacd.MACD >= prevMacd.signal) macdTrend = 'BEARISH';

  const rsiResult = RSI.calculate({ values: closes, period: 14 });
  const lastRsi = rsiResult[rsiResult.length - 1];

  let rsiStatus: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' = 'NEUTRAL';
  if (lastRsi >= 70) rsiStatus = 'OVERBOUGHT';
  else if (lastRsi <= 30) rsiStatus = 'OVERSOLD';

  const ma5 = SMA.calculate({ values: closes, period: 5 }).pop() || 0;
  const ma10 = SMA.calculate({ values: closes, period: 10 }).pop() || 0;
  const ma20 = SMA.calculate({ values: closes, period: 20 }).pop() || 0;
  const ma60 = SMA.calculate({ values: closes, period: 60 }).pop() || 0;

  let maTrend: 'ABOVE_ALL' | 'BELOW_ALL' | 'MIXED' = 'MIXED';
  if (currentPrice > ma5 && currentPrice > ma10 && currentPrice > ma20 && currentPrice > ma60) maTrend = 'ABOVE_ALL';
  else if (currentPrice < ma5 && currentPrice < ma10 && currentPrice < ma20 && currentPrice < ma60) maTrend = 'BELOW_ALL';

  return {
    macd: {
      macdLine: Number(lastMacd.MACD.toFixed(4)),
      signalLine: Number(lastMacd.signal.toFixed(4)),
      histogram: Number(lastMacd.histogram.toFixed(4)),
      trend: macdTrend,
    },
    rsi: {
      value: Number(lastRsi.toFixed(2)),
      status: rsiStatus,
    },
    movingAverages: {
      ma5: Number(ma5.toFixed(2)),
      ma10: Number(ma10.toFixed(2)),
      ma20: Number(ma20.toFixed(2)),
      ma60: Number(ma60.toFixed(2)),
      trend: maTrend,
    },
  };
}

// 执行一次策略，返回触发事件
export async function runStrategyOnce(strategy: Strategy): Promise<TriggerEvent[]> {
  const events: TriggerEvent[] = [];
  if (!strategy.enabled) return events;

  if (strategy.marketTimeOnly !== false && !isMarketOpen()) return events;

  const stocks = await fetchStockDataBatch(strategy.symbols);

  for (const stock of stocks) {
    const alertMode = strategy.alertMode || 'percent';
    const nowMs = Date.now();

    const alertIntervalMs = Math.max(0, Number(strategy.intervalMs || 0));
    const indicatorCooldownMs = Math.max(0, Number(strategy.cooldownMinutes || 0)) * 60 * 1000;

    const alertKey = `${strategy.id}:${stock.code}:ALERT`;

    // 目标价格模式
    if (alertMode === 'target') {
      if (
        typeof strategy.targetPriceUp === 'number' &&
        strategy.targetPriceUp > 0 &&
        stock.currentPrice >= strategy.targetPriceUp
      ) {
        const last = lastAlertSentAt.get(alertKey) || 0;
        if (alertIntervalMs <= 0 || nowMs - last >= alertIntervalMs) {
          lastAlertSentAt.set(alertKey, nowMs);
          events.push({
            symbol: stock.code,
            stockName: stock.name,
            reason: `涨幅至目标价: ${strategy.targetPriceUp}`,
            snapshot: {
              stock,
              threshold: { targetPriceUp: strategy.targetPriceUp },
            },
          });
        }
      } else if (
        typeof strategy.targetPriceDown === 'number' &&
        strategy.targetPriceDown > 0 &&
        stock.currentPrice <= strategy.targetPriceDown
      ) {
        const last = lastAlertSentAt.get(alertKey) || 0;
        if (alertIntervalMs <= 0 || nowMs - last >= alertIntervalMs) {
          lastAlertSentAt.set(alertKey, nowMs);
          events.push({
            symbol: stock.code,
            stockName: stock.name,
            reason: `跌幅至目标价: ${strategy.targetPriceDown}`,
            snapshot: {
              stock,
              threshold: { targetPriceDown: strategy.targetPriceDown },
            },
          });
        }
      }
    } else {
      // 百分比模式
      if (Math.abs(stock.changePercent) >= strategy.priceAlertPercent) {
        const last = lastAlertSentAt.get(alertKey) || 0;
        if (alertIntervalMs <= 0 || nowMs - last >= alertIntervalMs) {
          lastAlertSentAt.set(alertKey, nowMs);
          events.push({
            symbol: stock.code,
            stockName: stock.name,
            reason: `价格异动 (${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent}%)`,
            snapshot: {
              stock,
              threshold: { priceAlertPercent: strategy.priceAlertPercent },
            },
          });
        }
      }
    }

    // 技术面深度分析
    const needIndicator =
      strategy.enableMacdGoldenCross ||
      strategy.enableRsiOversold ||
      strategy.enableRsiOverbought ||
      strategy.enableMovingAverages;

    if (needIndicator) {
      const indicator = await calculateIndicatorSnapshot(stock.code, stock.currentPrice);
      if (!indicator) continue;

      if (strategy.enableMacdGoldenCross && indicator.macd?.trend === 'BULLISH') {
        const key = `${strategy.id}:${stock.code}:MACD 金叉 (买入信号)`;
        const last = lastIndicatorSentAt.get(key) || 0;
        if (indicatorCooldownMs <= 0 || nowMs - last >= indicatorCooldownMs) {
          lastIndicatorSentAt.set(key, nowMs);
          events.push({
            symbol: stock.code,
            stockName: stock.name,
            reason: 'MACD 金叉 (买入信号)',
            snapshot: { stock, indicator },
          });
        }
      }

      if (strategy.enableRsiOversold && indicator.rsi?.status === 'OVERSOLD') {
        const key = `${strategy.id}:${stock.code}:RSI 超卖 (潜在反弹)`;
        const last = lastIndicatorSentAt.get(key) || 0;
        if (indicatorCooldownMs <= 0 || nowMs - last >= indicatorCooldownMs) {
          lastIndicatorSentAt.set(key, nowMs);
          events.push({
            symbol: stock.code,
            stockName: stock.name,
            reason: 'RSI 超卖 (潜在反弹)',
            snapshot: { stock, indicator },
          });
        }
      }

      if (strategy.enableRsiOverbought && indicator.rsi?.status === 'OVERBOUGHT') {
        const key = `${strategy.id}:${stock.code}:RSI 超买 (回调风险)`;
        const last = lastIndicatorSentAt.get(key) || 0;
        if (indicatorCooldownMs <= 0 || nowMs - last >= indicatorCooldownMs) {
          lastIndicatorSentAt.set(key, nowMs);
          events.push({
            symbol: stock.code,
            stockName: stock.name,
            reason: 'RSI 超买 (回调风险)',
            snapshot: { stock, indicator },
          });
        }
      }

      if (strategy.enableMovingAverages && indicator.movingAverages?.trend === 'ABOVE_ALL') {
        const key = `${strategy.id}:${stock.code}:均线多头排列 (趋势偏多)`;
        const last = lastIndicatorSentAt.get(key) || 0;
        if (indicatorCooldownMs <= 0 || nowMs - last >= indicatorCooldownMs) {
          lastIndicatorSentAt.set(key, nowMs);
          events.push({
            symbol: stock.code,
            stockName: stock.name,
            reason: '均线多头排列 (趋势偏多)',
            snapshot: { stock, indicator },
          });
        }
      }
    }

    // 模式信号
    if (strategy.enablePatternSignal) {
      let pattern: PatternSignal | null = null;
      try {
        const prices = await fetchRecentPriceData(stock.code, '1');
        if (prices.length > 0) {
          pattern = detectBreakoutPullback(prices);
        }
      } catch {
        pattern = null;
      }

      if (pattern) {
        const reason = `${pattern.type} (${pattern.signal})`;
        const key = `${strategy.id}:${stock.code}:${reason}`;
        const last = lastIndicatorSentAt.get(key) || 0;
        if (indicatorCooldownMs <= 0 || nowMs - last >= indicatorCooldownMs) {
          lastIndicatorSentAt.set(key, nowMs);
          events.push({
            symbol: stock.code,
            stockName: stock.name,
            reason,
            snapshot: { stock, threshold: { pattern } },
          });
        }
      }
    }
  }

  return events;
}
