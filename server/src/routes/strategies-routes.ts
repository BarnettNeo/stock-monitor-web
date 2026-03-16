import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';

import { getDb, persist } from '../db';
import { requireAuth } from '../auth';
import { boolToInt, handleApiError, nowIso } from '../utils';
import { rowToStrategy } from '../mappers';
import { fetchStockDataBatch } from '../engine';

// 策略管理 API
// - 列表支持 name/username 模糊查询
// - 返回 createdByUsername（创建人用户名）
// - 普通用户可查看全部，但只能编辑/删除自己创建的；管理员全权限

const StrategyInputSchema = z.object({
  userId: z.string().nullable().optional(),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  symbols: z.string().min(1),
  marketTimeOnly: z.boolean().optional().default(true),
  subscriptionIds: z.array(z.string()).optional(),
  alertMode: z.enum(['percent', 'target']).optional().default('percent'),
  targetPriceUp: z.number().positive().optional(),
  targetPriceDown: z.number().positive().optional(),
  intervalMs: z.number().int().min(1000).default(60000),
  cooldownMinutes: z.number().int().min(1).default(60),
  priceAlertPercent: z.number().min(0.1).optional().default(2),
  enableMacdGoldenCross: z.boolean().default(true),
  enableRsiOversold: z.boolean().default(true),
  enableRsiOverbought: z.boolean().default(true),
  enableMovingAverages: z.boolean().default(false),
  enablePatternSignal: z.boolean().default(false),
});

export function registerStrategyRoutes(app: Express): void {
  app.get('/api/strategies', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const qName = typeof req.query?.name === 'string' ? String(req.query.name).trim() : '';
    const qUsername = typeof req.query?.username === 'string' ? String(req.query.username).trim() : '';

    const db = await getDb();

    const where: string[] = [];
    const params: any[] = [];
    if (qName) {
      where.push('s.name LIKE ?');
      params.push(`%${qName}%`);
    }
    if (qUsername) {
      where.push('u.username LIKE ?');
      params.push(`%${qUsername}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const stmt = db.prepare(
      `SELECT s.*, u.username AS created_by_username
       FROM strategies s
       LEFT JOIN users u ON u.id = s.user_id
       ${whereSql}
       ORDER BY s.updated_at DESC`,
    );
    stmt.bind(params);
    const items: any[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      items.push({
        ...rowToStrategy(row),
        createdByUsername: (row as any).created_by_username || (row as any).user_id || null,
      });
    }
    stmt.free();

    // 获取所有股票代码并查询名称
    const allSymbols = new Set<string>();
    for (const item of items) {
      if (item.symbols) {
        item.symbols.split(',').forEach((s: string) => {
          const trimmed = s.trim();
          if (trimmed) allSymbols.add(trimmed);
        });
      }
    }

    let stockNames: Record<string, string> = {};
    if (allSymbols.size > 0) {
      try {
        const stocks = await fetchStockDataBatch(Array.from(allSymbols));
        for (const stock of stocks) {
          stockNames[stock.code.toLowerCase()] = stock.name;
        }
      } catch (e) {
        console.warn('Failed to fetch stock names:', e);
      }
    }

    const itemsWithNames = items.map((item: any) => ({
      ...item,
      alertMode: item.alertMode || 'percent',
      stockNames: item.symbols
        ? item.symbols
            .split(',')
            .map((s: string) => {
              const trimmed = s.trim().toLowerCase();
              return stockNames[trimmed] || '';
            })
            .join(',')
        : '',
    }));

    res.json({ items: itemsWithNames });
  });

  app.get('/api/strategies/:id', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const db = await getDb();
    const stmt = db.prepare(
      `SELECT s.*, u.username AS created_by_username
       FROM strategies s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    );
    stmt.bind([req.params.id]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({
      item: {
        ...rowToStrategy(row),
        createdByUsername: (row as any).created_by_username || (row as any).user_id || null,
      },
    });
  });

  app.post('/api/strategies', async (req: Request, res: Response) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;

      const parsed = StrategyInputSchema.parse(req.body);
      const id = crypto.randomUUID();
      const ts = nowIso();
      const db = await getDb();

      const subscriptionIdsJson = parsed.subscriptionIds && parsed.subscriptionIds.length > 0
        ? JSON.stringify(parsed.subscriptionIds)
        : null;

      db.run(
        `INSERT INTO strategies (
          id,user_id,name,enabled,symbols,market_time_only,subscription_ids_json,alert_mode,target_price_up,target_price_down,interval_ms,cooldown_minutes,price_alert_percent,
          enable_macd_golden_cross,enable_rsi_oversold,enable_rsi_overbought,enable_moving_averages,enable_pattern_signal,
          created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          user.userId,
          parsed.name,
          boolToInt(parsed.enabled),
          parsed.symbols,
          boolToInt(parsed.marketTimeOnly !== false),
          subscriptionIdsJson,
          parsed.alertMode || 'percent',
          parsed.targetPriceUp ?? null,
          parsed.targetPriceDown ?? null,
          parsed.intervalMs,
          parsed.cooldownMinutes,
          parsed.priceAlertPercent,
          boolToInt(parsed.enableMacdGoldenCross),
          boolToInt(parsed.enableRsiOversold),
          boolToInt(parsed.enableRsiOverbought),
          boolToInt(parsed.enableMovingAverages),
          boolToInt(parsed.enablePatternSignal),
          ts,
          ts,
        ],
      );

      persist();
      res.json({ id });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  app.put('/api/strategies/:id', async (req: Request, res: Response) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;

      const parsed = StrategyInputSchema.parse(req.body);
      const ts = nowIso();
      const db = await getDb();

      const stmtOwner = db.prepare('SELECT user_id FROM strategies WHERE id = ?');
      stmtOwner.bind([req.params.id]);
      const ownerRow = stmtOwner.step() ? stmtOwner.getAsObject() : null;
      stmtOwner.free();
      if (!ownerRow) return res.status(404).json({ message: 'Not found' });
      const ownerId = (ownerRow as any).user_id ? String((ownerRow as any).user_id) : '';
      if (user.role !== 'admin' && ownerId !== user.userId) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      const subscriptionIdsJson = parsed.subscriptionIds && parsed.subscriptionIds.length > 0
        ? JSON.stringify(parsed.subscriptionIds)
        : null;

      db.run(
        `UPDATE strategies SET
          user_id=?,name=?,enabled=?,symbols=?,market_time_only=?,alert_mode=?,target_price_up=?,target_price_down=?,interval_ms=?,cooldown_minutes=?,price_alert_percent=?,
          enable_macd_golden_cross=?,enable_rsi_oversold=?,enable_rsi_overbought=?,enable_moving_averages=?,enable_pattern_signal=?,
          subscription_ids_json=?,updated_at=?
        WHERE id=?`,
        [
          user.role === 'admin' ? parsed.userId || ownerId || null : user.userId,
          parsed.name,
          boolToInt(parsed.enabled),
          parsed.symbols,
          boolToInt(parsed.marketTimeOnly !== false),
          parsed.alertMode || 'percent',
          parsed.targetPriceUp ?? null,
          parsed.targetPriceDown ?? null,
          parsed.intervalMs,
          parsed.cooldownMinutes,
          parsed.priceAlertPercent,
          boolToInt(parsed.enableMacdGoldenCross),
          boolToInt(parsed.enableRsiOversold),
          boolToInt(parsed.enableRsiOverbought),
          boolToInt(parsed.enableMovingAverages),
          boolToInt(parsed.enablePatternSignal),
          subscriptionIdsJson,
          ts,
          req.params.id,
        ],
      );

      persist();
      res.json({ ok: true });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  app.delete('/api/strategies/:id', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const db = await getDb();

    const stmtOwner = db.prepare('SELECT user_id FROM strategies WHERE id = ?');
    stmtOwner.bind([req.params.id]);
    const ownerRow = stmtOwner.step() ? stmtOwner.getAsObject() : null;
    stmtOwner.free();
    if (!ownerRow) return res.status(404).json({ message: 'Not found' });
    const ownerId = (ownerRow as any).user_id ? String((ownerRow as any).user_id) : '';
    if (user.role !== 'admin' && ownerId !== user.userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    db.run('DELETE FROM strategies WHERE id = ?', [req.params.id]);
    persist();
    res.json({ ok: true });
  });
}
