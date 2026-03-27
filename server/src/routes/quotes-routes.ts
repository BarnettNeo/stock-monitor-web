import type { Express, Request, Response } from 'express';

import { requireAuth } from '../auth';
import { fetchKLineData, resolveSinaCodeByName } from '../engine';
import { formatDate } from '../utils';

// 限制整数参数值在指定范围内，超出范围则返回默认值。
function clampInt(v: any, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// 注册 K 线收盘价序列路由。
export function registerQuoteRoutes(app: Express): void {
  // Resolve a Sina symbol by Chinese stock name (or a fuzzy query).
  // Example: q=贵州茅台 -> sh600519
  app.get('/api/quotes/resolve', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const q = typeof (req.query as any)?.q === 'string' ? String((req.query as any).q).trim() : '';
    if (!q) return res.status(400).json({ message: 'q is required' });

    try {
      const symbol = await resolveSinaCodeByName(q);
      res.json({ query: q, symbol: symbol || null });
    } catch (e: any) {
      res.status(502).json({ message: e?.message || 'resolve failed' });
    }
  });

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
      const items = prices.map((p: any) => ({
        time: p.time,
        open: p.open,
        high: p.high,
        low: p.low,
        close: p.close,
        volume: p.volume,
        percent: p.percent,
        turnover: p.turnoverrate,
        amplitude: ((p.high - p.low) / p.preclose) * 100,
        change: p.change,
        preclose: p.preclose,
      }));
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

