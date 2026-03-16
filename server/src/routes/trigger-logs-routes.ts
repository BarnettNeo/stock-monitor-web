import type { Express, Request, Response } from 'express';

import { getDb } from '../db';
import { requireAuth } from '../auth';

// 触发日志查询 API
// - 为避免页面卡顿，限制最多返回 200 条

export function registerTriggerLogRoutes(app: Express): void {
  app.get('/api/trigger-logs', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const db = await getDb();
    const result = db.exec('SELECT * FROM trigger_logs ORDER BY created_at DESC LIMIT 200');
    const rows = result[0]?.values || [];
    const cols = result[0]?.columns || [];
    const items = rows
      .map((v: any[]) => Object.fromEntries(v.map((x: any, i: number) => [cols[i], x])))
      .map((row: any) => ({
        id: row.id,
        createdAt: row.created_at,
        userId: row.user_id,
        strategyId: row.strategy_id,
        subscriptionId: row.subscription_id,
        symbol: row.symbol,
        stockName: row.stock_name || undefined,
        reason: row.reason,
        snapshot: JSON.parse(row.snapshot_json),
        sendStatus: row.send_status || undefined,
        sendError: row.send_error || undefined,
      }));

    res.json({ items });
  });
}
