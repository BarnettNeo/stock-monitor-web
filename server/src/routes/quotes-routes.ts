import type { Express, Request, Response } from 'express';

import { requireAuth } from '../auth';
import { fetchKLineData } from '../engine';
import { formatDate } from '../utils';

// 限制整数参数值在指定范围内，超出范围则返回默认值。
function clampInt(v: any, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// 注册 K 线收盘价序列路由。
export function registerQuoteRoutes(app: Express): void {
  app.get('/api/quotes/kline', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const symbol = typeof req.query.symbol === 'string' ? String(req.query.symbol).trim() : '';
    if (!symbol) {
      res.status(400).json({ message: 'symbol is required' });
      return;
    }

    const scale = typeof req.query.scale === 'string' ? String(req.query.scale).trim() : '240';
    const datalen = clampInt(req.query.datalen, 10, 500, 60);

    try {
      const prices = await fetchKLineData(symbol, scale, datalen);
      const items = prices.map((p) => ({ time: p.time, close: p.close }));
      res.json({
        serverTime: formatDate(new Date()),
        symbol,
        scale,
        datalen,
        items,
      });
    } catch (e: any) {
      res.status(502).json({ message: e?.message || 'fetch kline failed' });
    }
  });
}

