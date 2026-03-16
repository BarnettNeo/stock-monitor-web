export interface PriceData {
  high: number;
  low: number;
  close: number;
  volume?: number;
  time?: string;
  open?: number;
}

export interface PatternSignal {
  signal: 'BUY' | 'SELL';
  type: string;
  previousHigh: number;
  currentPrice: number;
  strength: number;
  message: string;
}

function calculateStrength(prices: PriceData[], referencePrice: number): number {
  if (prices.length < 5) return 50;

  const recentPrices = prices.slice(-5);
  const avgVolume = recentPrices.reduce((sum, p) => sum + (p.volume || 0), 0) / 5;

  const currentPrice = recentPrices[recentPrices.length - 1].close;
  const priceDistance = Math.abs(currentPrice - referencePrice) / referencePrice;

  let strength = 100 - priceDistance * 1000 + (avgVolume > 10000 ? 10 : 0);
  strength = Math.max(0, Math.min(100, strength));

  return Math.round(strength);
}

export function detectBreakoutPullback(
  prices: PriceData[],
  lookbackDays: number = 20,
  tolerance: number = 0.02,
): PatternSignal | null {
  if (prices.length < 2) return null;

  const current = prices[prices.length - 1];
  const previous = prices[prices.length - 2];

  const endIndex = Math.max(0, prices.length - 2);
  const startIndex = Math.max(0, endIndex - lookbackDays);
  const historicalPrices = prices.slice(startIndex, endIndex);

  if (historicalPrices.length === 0) return null;

  const previousHigh = Math.max(...historicalPrices.map(p => p.high));
  const previousLow = Math.min(...historicalPrices.map(p => p.low));

  const wasBreakout = previous.close > previousHigh * (1 + tolerance);
  const isPullback = current.low <= previousHigh && current.low >= previousHigh * (1 - tolerance);
  const isHolding = current.close >= previousHigh * (1 - tolerance);

  if (wasBreakout && isPullback && isHolding) {
    return {
      signal: 'BUY',
      type: '突破回踩',
      previousHigh,
      currentPrice: current.close,
      strength: calculateStrength(prices, previousHigh),
      message: `突破前高 ${previousHigh.toFixed(2)} 后回踩不破，现价 ${current.close.toFixed(2)}`,
    };
  }

  const wasBreakdown = previous.close < previousLow * (1 - tolerance);
  const isReboundFail = current.high >= previousLow * (1 - tolerance) && current.close <= previousLow;

  if (wasBreakdown && isReboundFail) {
    return {
      signal: 'SELL',
      type: '破位反抽',
      previousHigh: previousLow,
      currentPrice: current.close,
      strength: calculateStrength(prices, previousLow),
      message: `跌破前低 ${previousLow.toFixed(2)} 后反抽失败，现价 ${current.close.toFixed(2)}`,
    };
  }

  return null;
}
