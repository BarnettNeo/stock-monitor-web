export interface PriceData {
  high: number;      // 最高价
  low: number;       // 最低价
  close: number;     // 收盘价
  volume?: number;   // 成交量 (可选)
  time?: string;     // 时间 (可选)
}

// 形态学信号接口
export interface PatternSignal {
  signal: 'BUY' | 'SELL';
  type: string;      // 形态名称
  previousHigh: number; // 参考前高
  currentPrice: number; // 当前价格
  strength: number;     // 信号强度 (0-100)
  message: string;      // 描述信息
}

/**
 * 计算信号强度
 * @param prices - 最近的价格数据
 * @param referencePrice - 参考基准价 (通常是前高或前低)
 * @returns 强度分数 (0-100)
 */
function calculateStrength(prices: PriceData[], referencePrice: number): number {
  if (prices.length < 5) return 50;

  // 取最近5天的成交量均值
  const recentPrices = prices.slice(-5);
  const avgVolume = recentPrices.reduce((sum, p) => sum + (p.volume || 0), 0) / 5;
  
  // 计算当前收盘价与基准价的距离
  const currentPrice = recentPrices[recentPrices.length - 1].close;
  const priceDistance = Math.abs(currentPrice - referencePrice) / referencePrice;

  // 距离越近、成交量越大，强度越高
  // 这里简化处理，实际可根据需求加入更多因子
  let strength = 100 - (priceDistance * 1000) + (avgVolume > 10000 ? 10 : 0);
  strength = Math.max(0, Math.min(100, strength));

  return Math.round(strength);
}

/**
 * 检测突破回踩形态
 * @param prices - 历史价格数组 (倒序排列，最新数据在最后)
 * @param lookbackDays - 回溯天数 (默认20天)
 * @param tolerance - 容差百分比 (默认2%)
 */
export function detectBreakoutPullback(
  prices: PriceData[], 
  lookbackDays: number = 20, 
  tolerance: number = 0.02
): PatternSignal | null {

  if (prices.length < 2) return null;

  const current = prices[prices.length - 1];   // 最新K线
  const previous = prices[prices.length - 2];  // 前一根K线

  // 1. 找出前高/前低 (lookbackDays 内，且不包含前一根、当前K线)
  const endIndex = Math.max(0, prices.length - 2);
  const startIndex = Math.max(0, endIndex - lookbackDays);
  const historicalPrices = prices.slice(startIndex, endIndex);

  if (historicalPrices.length === 0) {
    return null;
  }
  const previousHigh = Math.max(...historicalPrices.map(p => p.high));
  const previousLow = Math.min(...historicalPrices.map(p => p.low));

  // 2. 判断是否曾经突破前高 (昨日收盘价 > 前高 * (1+容差))
  const wasBreakout = previous.close > previousHigh * (1 + tolerance);

  // 3. 判断当前是否回踩 (当前最低价 < 前高，且 > 前高 * (1-容差))
  const isPullback = current.low <= previousHigh && 
                     current.low >= previousHigh * (1 - tolerance);

  // 4. 判断是否不破位 (收盘价在支撑位之上)
  const isHolding = current.close >= previousHigh * (1 - tolerance);

  // ✅ 买入信号逻辑
  if (wasBreakout && isPullback && isHolding) {
    return {
      signal: 'BUY',
      type: '突破回踩',
      previousHigh,
      currentPrice: current.close,
      strength: calculateStrength(prices, previousHigh),
      message: `突破前高 ${previousHigh.toFixed(2)} 后回踩不破，现价 ${current.close.toFixed(2)}`
    };
  }

  // 6. 检测反向信号 (跌破前低后反抽不过)
  const wasBreakdown = previous.close < previousLow * (1 - tolerance);
  const isReboundFail = current.high >= previousLow * (1 - tolerance) && 
                        current.close <= previousLow;

  // ❌ 卖出信号逻辑
  if (wasBreakdown && isReboundFail) {
    return {
      signal: 'SELL',
      type: '破位反抽',
      previousHigh: previousLow, // 这里用前低作为参考
      currentPrice: current.close,
      strength: calculateStrength(prices, previousLow),
      message: `跌破前低 ${previousLow.toFixed(2)} 后反抽失败，现价 ${current.close.toFixed(2)}`
    };
  }

  return null;
}
