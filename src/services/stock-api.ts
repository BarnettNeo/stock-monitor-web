import axios from 'axios';
import iconv from 'iconv-lite';

export interface StockData {
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
}

export class StockApiService {
  private readonly baseURL = 'https://hq.sinajs.cn/rn=' + Date.now();

  async getStockData(code: string): Promise<StockData | null> {
    try {
      const response = await axios.get(`${this.baseURL}&list=${code}`, {
        timeout: 5000,
        responseType: 'arraybuffer',
        headers: {
          Referer: 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const decoded = iconv.decode(Buffer.from(response.data), 'gbk');
      const match = decoded.match(/var hq_str_[\w]+="(.+)"/);
      if (!match || !match[1]) {
        console.warn(`⚠️ 股票 ${code} 数据解析失败`);
        return null;
      }

      const fields = match[1].split(',');

      if (fields.length < 30 || fields[0] === '') {
        console.warn(`⚠️ 股票 ${code} 可能停牌或数据异常`);
        return null;
      }

      const currentPrice = parseFloat(fields[3]) || 0;
      const closePrice = parseFloat(fields[2]) || 0;
      const changePercent =
        closePrice > 0 ? ((currentPrice - closePrice) / closePrice) * 100 : 0;

      const stockData: StockData = {
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
      };

      return stockData;
    } catch (error) {
      if (error instanceof Error) {
        console.error(`❌ 获取股票 ${code} 数据失败:`, error.message);
      }
      return null;
    }
  }

  async getStockDataBatch(codes: string[]): Promise<StockData[]> {
    const results: StockData[] = [];

    const codeList = codes.join(',');

    try {
      const response = await axios.get(`${this.baseURL}&list=${codeList}`, {
        timeout: 10000,
        responseType: 'arraybuffer',
        headers: {
          Referer: 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const decoded = iconv.decode(Buffer.from(response.data), 'gbk');
      const lines = decoded.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const match = line.match(/var hq_str_([\w]+)="(.+)"/);
        if (!match || !match[2]) continue;

        const code = match[1].toUpperCase();
        const fields = match[2].split(',');

        if (fields.length < 30 || fields[0] === '') continue;

        const currentPrice = parseFloat(fields[3]) || 0;
        const closePrice = parseFloat(fields[2]) || 0;
        const changePercent =
          closePrice > 0 ? ((currentPrice - closePrice) / closePrice) * 100 : 0;

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
    } catch (error) {
      if (error instanceof Error) {
        console.error('❌ 批量获取股票数据失败:', error.message);
      }
    }

    return results;
  }
}

export const stockApiService = new StockApiService();

