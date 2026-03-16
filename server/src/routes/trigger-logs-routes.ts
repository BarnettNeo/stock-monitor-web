import type { Express, Request, Response } from 'express';

import { getDb } from '../db';
import { requireAuth } from '../auth';
import { fetchRecentPriceData } from '../engine';
import { calculateIndicatorSnapshot } from '../engine';

// 触发日志查询 API（支持分页与查询参数）
export function registerTriggerLogRoutes(app: Express): void {
  app.get('/api/trigger-logs', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const page = Math.max(1, Number((req.query.page as string) || '1') || 1);
    const rawPageSize = Number((req.query.pageSize as string) || '20') || 20;
    const pageSize = Math.min(Math.max(rawPageSize, 1), 100);

    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate.trim() : '';
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate.trim() : '';
    const type = typeof req.query.type === 'string' ? req.query.type.trim() : '';

    let whereSql = 'WHERE 1=1';
    const params: any[] = [];

    if (symbol) {
      whereSql += ' AND symbol LIKE ?';
      params.push(`%${symbol}%`);
    }
    if (startDate) {
      whereSql += ' AND substr(created_at,1,10) >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereSql += ' AND substr(created_at,1,10) <= ?';
      params.push(endDate);
    }

    if (type === 'indicator') {
      whereSql += ' AND snapshot_json LIKE ?';
      params.push('%"indicator":%');
    } else if (type === 'pattern') {
      whereSql += ' AND snapshot_json LIKE ?';
      params.push('%"pattern":{"signal"%');
    } else if (type === 'price') {
      whereSql +=
        ' AND snapshot_json LIKE ? AND snapshot_json NOT LIKE ? AND snapshot_json NOT LIKE ?';
      params.push('%"priceAlertPercent"%', '%"indicator":%', '%"pattern":{"signal"%');
    }

    const db = await getDb();

    const offset = (page - 1) * pageSize;

    const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM trigger_logs ${whereSql}`);
    countStmt.bind(params);
    let total = 0;
    if (countStmt.step()) {
      const row = countStmt.getAsObject() as any;
      total = Number(row.cnt || 0);
    }
    countStmt.free();

    const listStmt = db.prepare(
      `SELECT * FROM trigger_logs ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    listStmt.bind([...params, pageSize, offset]);

    const rows: any[] = [];
    while (listStmt.step()) {
      rows.push(listStmt.getAsObject());
    }
    listStmt.free();

    const items = rows.map((row: any) => {
      const snapshot = JSON.parse(row.snapshot_json);
      return {
        id: row.id,
        createdAt: row.created_at,
        userId: row.user_id,
        strategyId: row.strategy_id,
        subscriptionId: row.subscription_id,
        symbol: row.symbol,
        stockName: row.stock_name || undefined,
        reason: row.reason,
        snapshot,
        sendStatus: row.send_status || undefined,
        sendError: row.send_error || undefined,
      };
    });

    res.json({ items, page, pageSize, total });
  });

  app.get('/api/trigger-logs/:id', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const db = await getDb();
    const stmt = db.prepare('SELECT * FROM trigger_logs WHERE id = ?');
    stmt.bind([req.params.id]);
    let row: any | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();

    if (!row) {
      res.status(404).json({ message: 'Not found' });
      return;
    }

    const snapshot = JSON.parse((row as any).snapshot_json);
    const item = {
      id: row.id,
      createdAt: row.created_at,
      userId: row.user_id,
      strategyId: row.strategy_id,
      subscriptionId: row.subscription_id,
      symbol: row.symbol,
      stockName: row.stock_name || undefined,
      reason: row.reason,
      snapshot,
      sendStatus: row.send_status || undefined,
      sendError: row.send_error || undefined,
    };

    const klineRaw = await fetchRecentPriceData(item.symbol, '1');

    const kline = await Promise.all(
      klineRaw.map(async (k) => {
        const indicator = await calculateIndicatorSnapshot(item.symbol, k.close);
        return {
          date: k.time,
          open: k.open,
          close: k.close,
          high: k.high,
          low: k.low,
          volume: k.volume,
          indicator,
        };
      }),
    );

    res.json({ item: { ...item, kline } });
  });
}
