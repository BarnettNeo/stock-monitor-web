import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';

import { execute, query, queryOne } from '../db';
import { requireAuth } from '../auth';
import { boolToInt, handleApiError, nowIso } from '../utils';
import { rowToStrategy } from '../mappers';
import { fetchStockDataBatch } from '../engine';
import { addClause, createWhereBuilder, normalizePagination, toWhereSql } from '../sql-utils';
import { getPackageInfoByUserId, validateCreateStrategyPermission } from '../package-rule';

function normalizeName(name: string): string {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function parseSymbolsList(symbols: string): string[] {
  const parts = String(symbols || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Keep order but de-dup case-insensitively
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

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
  enableVolumeSignal: z.boolean().default(false),
  volumeMultiplier: z.number().min(1.01).default(1.5),
  enablePatternSignal: z.boolean().default(false),
});

async function validateSubscriptionOwnership(
  user: { userId: string; role: 'admin' | 'user' },
  subscriptionIds: string[] | undefined,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!subscriptionIds || subscriptionIds.length === 0) return { ok: true };
  if (user.role === 'admin') return { ok: true };

  for (const subId of subscriptionIds) {
    const row = await queryOne<any>('SELECT user_id FROM subscriptions WHERE id = ? LIMIT 1', [
      subId,
    ]);

    if (!row) return { ok: false, status: 400, message: '订阅不存在' };
    const ownerId = (row as any).user_id ? String((row as any).user_id) : '';
    if (ownerId !== user.userId) return { ok: false, status: 403, message: 'Forbidden' };
  }

  return { ok: true };
}

export function registerStrategyRoutes(app: Express): void {
  app.get('/api/strategies', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { page, pageSize, offset } = normalizePagination(req.query.page, req.query.pageSize, 100, 10);

    const qName = typeof req.query?.name === 'string' ? String(req.query.name).trim() : '';
    const qUsername = typeof req.query?.username === 'string' ? String(req.query.username).trim() : '';

    const where = createWhereBuilder();

    if (qName) {
      addClause(where, 's.name LIKE ?', `%${qName}%`);
    }
    if (qUsername) {
      addClause(where, 'u.username LIKE ?', `%${qUsername}%`);
    }
    const { whereSql, params } = toWhereSql(where);

    const totalRow = await queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM strategies s
       LEFT JOIN users u ON u.id = s.user_id
       ${whereSql}`,
      params,
    );
    const total = Number(totalRow?.cnt || 0);

    const rows = await query<any>(
      `SELECT s.*, u.username AS created_by_username
       FROM strategies s
       LEFT JOIN users u ON u.id = s.user_id
       ${whereSql}
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const items: any[] = rows.map((row) => ({
      ...rowToStrategy(row),
      createdByUsername: (row as any).created_by_username || (row as any).user_id || null,
    }));


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

    res.json({ items: itemsWithNames, page, pageSize, total });

  });

  app.get('/api/strategies/:id', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const row = await queryOne<any>(
      `SELECT s.*, u.username AS created_by_username
       FROM strategies s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?
       LIMIT 1`,
      [req.params.id],
    );
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
      const targetUserId = user.role === 'admin' ? (parsed.userId || user.userId) : user.userId;

      const name = normalizeName(parsed.name);
      if (!name) return res.status(400).json({ message: '策略名称不能为空' });

      const symbolsList = parseSymbolsList(parsed.symbols);
      const symbols = symbolsList.join(',');

      // Free users: each strategy can monitor at most 2 symbols.
      const pkgInfo = await getPackageInfoByUserId(targetUserId);
      if (pkgInfo.userPackage === 'free' && symbolsList.length > 2) {
        return res.status(403).json({ message: '当前用户是免费版，无法添加更多的监听策略' });
      }

      const indicatorInput = {
        enableRsiOversold: parsed.enableRsiOversold,
        enableRsiOverbought: parsed.enableRsiOverbought,
        enableMovingAverages: parsed.enableMovingAverages,
        enableVolumeSignal: parsed.enableVolumeSignal,
        enablePatternSignal: parsed.enablePatternSignal,
      };

      const permission = await validateCreateStrategyPermission(
        user.role === 'admin' && targetUserId !== user.userId
          ? ({ userId: targetUserId, username: '', role: 'user' } as any)
          : user,
        indicatorInput,
      );
      if (!permission.ok) {
        return res
          .status(permission.status)
          .json({ message: permission.message, package: permission.info });
      }

      const dup = await queryOne<any>(
        'SELECT id FROM strategies WHERE user_id = ? AND name = ? LIMIT 1',
        [targetUserId, name],
      );
      if (dup) {
        return res.status(400).json({ message: '策略名称已存在' });
      }

      const id = crypto.randomUUID();
      const ts = nowIso();
      const subCheck = await validateSubscriptionOwnership(user, parsed.subscriptionIds);
      if (!subCheck.ok) return res.status(subCheck.status).json({ message: subCheck.message });

      const subscriptionIdsJson = parsed.subscriptionIds && parsed.subscriptionIds.length > 0
        ? JSON.stringify(parsed.subscriptionIds)
        : null;

      await execute(
        `INSERT INTO strategies (
          id,user_id,name,enabled,symbols,market_time_only,subscription_ids_json,alert_mode,target_price_up,target_price_down,interval_ms,cooldown_minutes,price_alert_percent,
          enable_macd_golden_cross,enable_rsi_oversold,enable_rsi_overbought,enable_moving_averages,enable_volume_signal,volume_multiplier,enable_pattern_signal,
          created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          targetUserId,
          name,
          boolToInt(parsed.enabled),
          symbols,
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
          boolToInt(parsed.enableVolumeSignal),
          parsed.volumeMultiplier,
          boolToInt(parsed.enablePatternSignal),
          ts,
          ts,
        ],
      );

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
      const ownerRow = await queryOne<any>(
        'SELECT user_id FROM strategies WHERE id = ? LIMIT 1',
        [req.params.id],
      );
      if (!ownerRow) return res.status(404).json({ message: 'Not found' });
      const ownerId = (ownerRow as any).user_id ? String((ownerRow as any).user_id) : '';
      if (user.role !== 'admin' && ownerId !== user.userId) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      const targetUserId = user.role === 'admin' ? (parsed.userId || ownerId || null) : user.userId;
      if (!targetUserId) return res.status(400).json({ message: 'userId is required' });

      const name = normalizeName(parsed.name);
      if (!name) return res.status(400).json({ message: '策略名称不能为空' });

      const symbolsList = parseSymbolsList(parsed.symbols);
      const symbols = symbolsList.join(',');

      const pkgInfo = await getPackageInfoByUserId(targetUserId);
      if (pkgInfo.userPackage === 'free' && symbolsList.length > 2) {
        return res.status(403).json({ message: '当前用户是免费版，无法添加更多的监听策略' });
      }

      const dup = await queryOne<any>(
        'SELECT id FROM strategies WHERE user_id = ? AND name = ? AND id <> ? LIMIT 1',
        [targetUserId, name, req.params.id],
      );
      if (dup) {
        return res.status(400).json({ message: '策略名称已存在' });
      }

      const subCheck = await validateSubscriptionOwnership(user, parsed.subscriptionIds);
      if (!subCheck.ok) return res.status(subCheck.status).json({ message: subCheck.message });

      const subscriptionIdsJson = parsed.subscriptionIds && parsed.subscriptionIds.length > 0
        ? JSON.stringify(parsed.subscriptionIds)
        : null;

      await execute(
        `UPDATE strategies SET
          user_id=?,name=?,enabled=?,symbols=?,market_time_only=?,alert_mode=?,target_price_up=?,target_price_down=?,interval_ms=?,cooldown_minutes=?,price_alert_percent=?,
          enable_macd_golden_cross=?,enable_rsi_oversold=?,enable_rsi_overbought=?,enable_moving_averages=?,enable_volume_signal=?,volume_multiplier=?,enable_pattern_signal=?,
          subscription_ids_json=?,updated_at=?
        WHERE id=?`,
        [
          targetUserId,
          name,
          boolToInt(parsed.enabled),
          symbols,
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
          boolToInt(parsed.enableVolumeSignal),
          parsed.volumeMultiplier,
          boolToInt(parsed.enablePatternSignal),
          subscriptionIdsJson,
          ts,
          req.params.id,
        ],
      );

      res.json({ ok: true });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  app.delete('/api/strategies/:id', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const ownerRow = await queryOne<any>('SELECT user_id FROM strategies WHERE id = ? LIMIT 1', [
      req.params.id,
    ]);
    if (!ownerRow) return res.status(404).json({ message: 'Not found' });
    const ownerId = (ownerRow as any).user_id ? String((ownerRow as any).user_id) : '';
    if (user.role !== 'admin' && ownerId !== user.userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    await execute('DELETE FROM strategies WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });
}
