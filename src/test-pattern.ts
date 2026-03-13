import { detectBreakoutPullback, type PriceData } from './services/stock-pattern';
import { DingTalkService } from './services/dingtalk-service';
import type { StockData } from './services/stock-api';

// 直接复用项目里的 config.js，选一个已启用的群的 webhook/keyword
const CONFIG = require('../config') as { groups: any[] };

const testPricesBuy: PriceData[] = [
  // 历史阶段：前高约 10.0
  { high: 9.2, low: 8.9, close: 9.0, volume: 12000, time: '2024-01-01' },
  { high: 9.4, low: 9.0, close: 9.3, volume: 13000, time: '2024-01-02' },
  { high: 9.6, low: 9.1, close: 9.5, volume: 11000, time: '2024-01-03' },
  { high: 9.7, low: 9.2, close: 9.6, volume: 15000, time: '2024-01-04' },
  { high: 9.8, low: 9.3, close: 9.7, volume: 14000, time: '2024-01-05' },
  { high: 9.9, low: 9.4, close: 9.8, volume: 16000, time: '2024-01-08' },
  { high: 9.8, low: 9.3, close: 9.6, volume: 10000, time: '2024-01-09' },
  { high: 9.9, low: 9.4, close: 9.7, volume: 9000, time: '2024-01-10' },
  { high: 10.0, low: 9.5, close: 9.9, volume: 17000, time: '2024-01-11' },
  { high: 9.9, low: 9.4, close: 9.8, volume: 13000, time: '2024-01-12' },
  { high: 9.8, low: 9.3, close: 9.6, volume: 14000, time: '2024-01-15' },
  { high: 9.9, low: 9.4, close: 9.7, volume: 15000, time: '2024-01-16' },
  { high: 9.7, low: 9.2, close: 9.5, volume: 11000, time: '2024-01-17' },
  { high: 9.8, low: 9.3, close: 9.6, volume: 12000, time: '2024-01-18' },
  { high: 9.9, low: 9.4, close: 9.8, volume: 15000, time: '2024-01-19' },
  { high: 9.8, low: 9.3, close: 9.6, volume: 10000, time: '2024-01-22' },
  { high: 10.0, low: 9.5, close: 9.9, volume: 13000, time: '2024-01-23' },

  // 前一根K线：有效突破前高 (收盘 > 前高 * 1.02)
  { high: 10.8, low: 10.3, close: 10.5, volume: 20000, time: '2024-01-24' },

  // 当前K线：回踩前高附近，不破位，收盘站稳
  { high: 10.3, low: 9.9, close: 10.0, volume: 18000, time: '2024-01-25' },
];

const testPricesSell: PriceData[] = [
  // 历史阶段：前低约 10.0
  { high: 10.5, low: 10.1, close: 10.3, volume: 15000, time: '2024-02-01' },
  { high: 10.4, low: 10.0, close: 10.1, volume: 16000, time: '2024-02-02' },
  { high: 10.3, low: 10.0, close: 10.0, volume: 14000, time: '2024-02-03' },
  { high: 10.2, low: 10.0, close: 10.0, volume: 13000, time: '2024-02-04' },
  { high: 10.1, low: 10.0, close: 10.0, volume: 12000, time: '2024-02-05' },
  { high: 10.2, low: 10.0, close: 10.1, volume: 11000, time: '2024-02-06' },
  { high: 10.3, low: 10.0, close: 10.2, volume: 10000, time: '2024-02-07' },
  { high: 10.4, low: 10.0, close: 10.3, volume: 9000, time: '2024-02-08' },
  { high: 10.2, low: 10.0, close: 10.1, volume: 9500, time: '2024-02-09' },
  { high: 10.3, low: 10.0, close: 10.2, volume: 9800, time: '2024-02-12' },
  { high: 10.4, low: 10.0, close: 10.3, volume: 10200, time: '2024-02-13' },
  { high: 10.2, low: 10.0, close: 10.1, volume: 11000, time: '2024-02-14' },
  { high: 10.1, low: 10.0, close: 10.0, volume: 12000, time: '2024-02-15' },
  { high: 10.2, low: 10.0, close: 10.1, volume: 13000, time: '2024-02-16' },

  // 前一根K线：有效跌破前低 (收盘 < 前低 * (1 - 容差))
  { high: 9.8, low: 9.4, close: 9.5, volume: 18000, time: '2024-02-19' },

  // 当前K线：反抽靠近前低，但收盘仍在前低之下
  { high: 10.0, low: 9.5, close: 9.7, volume: 17000, time: '2024-02-20' },
];

async function run() {
  const group =
    CONFIG.groups.find(g => g.enabled !== false) || CONFIG.groups[0];

  const dingTalk = new DingTalkService({
    webhookUrl: group.webhook,
    keyword: group.keyword,
  });

  console.log('=== 测试 BUY 信号（突破回踩） ===');
  const buySignal = detectBreakoutPullback(testPricesBuy);
  console.log(buySignal);

  if (buySignal) {
    const last = testPricesBuy[testPricesBuy.length - 1];
    const stock: StockData = {
      code: 'TEST_BUY',
      name: '测试形态股-BUY',
      currentPrice: buySignal.currentPrice,
      openPrice: last.close,
      closePrice: last.close,
      highPrice: last.high,
      lowPrice: last.low,
      volume: last.volume || 0,
      amount: 0,
      changePercent: 0,
      changePrice: 0,
      timestamp: new Date().toLocaleString('zh-CN'),
    };

    console.log('>>> 发送 BUY 形态钉钉消息...');
    await dingTalk.sendPatternAlert(stock, buySignal);
  }

  console.log('\n=== 测试 SELL 信号（破位反抽） ===');
  const sellSignal = detectBreakoutPullback(testPricesSell);
  console.log(sellSignal);

  if (sellSignal) {
    const last = testPricesSell[testPricesSell.length - 1];
    const stock: StockData = {
      code: 'TEST_SELL',
      name: '测试形态股-SELL',
      currentPrice: sellSignal.currentPrice,
      openPrice: last.close,
      closePrice: last.close,
      highPrice: last.high,
      lowPrice: last.low,
      volume: last.volume || 0,
      amount: 0,
      changePercent: 0,
      changePrice: 0,
      timestamp: new Date().toLocaleString('zh-CN'),
    };

    console.log('>>> 发送 SELL 形态钉钉消息...');
    await dingTalk.sendPatternAlert(stock, sellSignal);
  }
}

run().catch(err => {
  console.error('test-pattern 运行出错:', err);
});
