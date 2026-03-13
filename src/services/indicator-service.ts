import { MACD, RSI, SMA, EMA } from 'technicalindicators';
import axios from 'axios';
import type { PriceData } from './stock-pattern';

// 技术指标结果接口
export interface IndicatorResult {
  code: string;
  name: string;
  currentPrice: number;
  macd: {
    macdLine: number;
    signalLine: number;
    histogram: number;
    trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  };
  rsi: {
    value: number;
    status: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
  };
  movingAverages: {
    ma5: number;
    ma10: number;
    ma20: number;
    ma60: number;
    trend: 'ABOVE_ALL' | 'BELOW_ALL' | 'MIXED';
  };
  timestamp: string;
}

// 计算技术指标数据
async function fetchHistoryData(code: string, period: string = '1'): Promise<number[]> {
  try {
    const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${code}&scale=${period}&datalen=240`;

    const response = await axios.get(url, {
      timeout: 5000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Referer: 'https://finance.sina.com.cn/',
      },
    });

    const klines = response.data;

    if (!Array.isArray(klines) || klines.length === 0) {
      throw new Error('API returned empty array');
    }

    const closes = klines.map((k: any) => parseFloat(k.close));

    const validCloses = closes.filter(c => !isNaN(c));

    if (validCloses.length < 60) {
      console.warn(
        `⚠️ ${code} 有效数据只有 ${validCloses.length} 条，可能不足以计算长周期指标`,
      );
    }

    return validCloses;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`❌ 获取 ${code} 历史数据失败:`, error.message);
      if (axios.isAxiosError(error)) {
        console.error(
          `   Status: ${error.response?.status}, Data: ${JSON.stringify(
            error.response?.data,
          )}`,
        );
      }
    }
    return [];
  }
}

// 获取最近240条价格数据
export async function getRecentPriceData(
  code: string,
  period: string = '1',
): Promise<PriceData[]> {
  try {
    const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${code}&scale=${period}&datalen=240`;

    const response = await axios.get(url, {
      timeout: 5000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Referer: 'https://finance.sina.com.cn/',
      },
    });

    const klines = response.data;

    if (!Array.isArray(klines) || klines.length === 0) {
      return [];
    }

    const prices: PriceData[] = klines
      .map((k: any) => {
        const high = parseFloat(k.high);
        const low = parseFloat(k.low);
        const close = parseFloat(k.close);
        const volume = k.volume !== undefined ? Number(k.volume) : Number(k.vol || 0);

        if (isNaN(high) || isNaN(low) || isNaN(close)) {
          return null;
        }

        return {
          high,
          low,
          close,
          volume: isNaN(volume) ? 0 : volume,
          time: k.day || k.date || '',
        } as PriceData;
      })
      .filter((p: PriceData | null): p is PriceData => p !== null);

    return prices;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`❌ 获取 ${code} 价格形态数据失败:`, error.message);
    }
    return [];
  }
}

export class IndicatorService {
  // 计算技术指标
  async calculateIndicators(
    code: string,
    name: string,
    currentPrice: number,
  ): Promise<IndicatorResult | null> {
    const closes = await fetchHistoryData(code, '1');
    // console.log(`✅ ${code} 历史数据获取成功`);
    if (closes.length < 60) {
      console.warn(`⚠️ ${code} 历史数据不足，跳过指标计算`);
      return null;
    }

    const macdInput: any = {
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    };
    const macdResult: any[] = MACD.calculate(macdInput) || [];

    if (macdResult.length < 2) {
      console.warn(`⚠️ ${code} MACD 结果不足，长度=${macdResult.length}，跳过指标计算`);
      return null;
    }

    const lastMacd: any = macdResult[macdResult.length - 1];
    const prevMacd: any = macdResult[macdResult.length - 2];

    let macdTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (lastMacd.MACD > lastMacd.signal && prevMacd.MACD <= prevMacd.signal) {
      macdTrend = 'BULLISH';
    } else if (lastMacd.MACD < lastMacd.signal && prevMacd.MACD >= prevMacd.signal) {
      macdTrend = 'BEARISH';
    }

    const rsiInput = { values: closes, period: 14 };
    const rsiResult = RSI.calculate(rsiInput);
    const lastRsi = rsiResult[rsiResult.length - 1];

    let rsiStatus: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' = 'NEUTRAL';
    if (lastRsi >= 70) rsiStatus = 'OVERBOUGHT';
    else if (lastRsi <= 30) rsiStatus = 'OVERSOLD';

    const ma5 = SMA.calculate({ values: closes, period: 5 }).pop() || 0;
    const ma10 = SMA.calculate({ values: closes, period: 10 }).pop() || 0;
    const ma20 = SMA.calculate({ values: closes, period: 20 }).pop() || 0;
    const ma60 = SMA.calculate({ values: closes, period: 60 }).pop() || 0;

    let maTrend: 'ABOVE_ALL' | 'BELOW_ALL' | 'MIXED' = 'MIXED';
    if (
      currentPrice > ma5 &&
      currentPrice > ma10 &&
      currentPrice > ma20 &&
      currentPrice > ma60
    ) {
      maTrend = 'ABOVE_ALL';
    } else if (
      currentPrice < ma5 &&
      currentPrice < ma10 &&
      currentPrice < ma20 &&
      currentPrice < ma60
    ) {
      maTrend = 'BELOW_ALL';
    }

    // console.log(`✅ ${name}${code} 指标计算完成`);

    return {
      code,
      name,
      currentPrice,
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
      timestamp: new Date().toLocaleString('zh-CN'),
    };
  }
}

export const indicatorService = new IndicatorService();

