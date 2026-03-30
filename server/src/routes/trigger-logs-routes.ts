import type { Express, Request, Response } from 'express';

import { query, queryOne } from '../db';
import { requireAuth } from '../auth';
import { fetchRecentPriceData, calculateIndicatorSnapshot } from '../engine';

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
import {
  addClause,
  addDatePrefixRange,
  createWhereBuilder,
  normalizePagination,
  queryPaged,
  toWhereSql,
} from '../sql-utils';
import { formatDate } from '../utils';

// 触发日志查询 API（支持分页与查询参数）
export function registerTriggerLogRoutes(app: Express): void {
  app.get('/api/trigger-logs', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { page, pageSize, offset } = normalizePagination(req.query.page, req.query.pageSize);

    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate.trim() : '';
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate.trim() : '';
    const type = typeof req.query.type === 'string' ? req.query.type.trim() : '';

    // 统一用 builder 维护 where + params，避免动态拼接时遗漏参数顺序。
    const where = createWhereBuilder();

    if (symbol) {
      addClause(where, 'symbol LIKE ?', `%${symbol}%`);
    }
    addDatePrefixRange(where, 'created_at', startDate, endDate);

    if (type === 'indicator') {
      addClause(where, 'snapshot_json LIKE ?', '%"indicator":%');
    } else if (type === 'pattern') {
      addClause(where, 'snapshot_json LIKE ?', '%"pattern":{"signal"%');
    } else if (type === 'price') {
      addClause(where, 'snapshot_json LIKE ?', '%"priceAlertPercent"%');
      addClause(where, 'snapshot_json NOT LIKE ?', '%"indicator":%');
      addClause(where, 'snapshot_json NOT LIKE ?', '%"pattern":{"signal"%');
    }
    const { whereSql, params } = toWhereSql(where);

    const { total, rows } = await queryPaged<any>({
      baseFromSql: 'FROM trigger_logs',
      whereSql,
      params,
      orderBySql: 'ORDER BY created_at DESC',
      pageSize,
      offset,
      queryOne,
      query,
    });

    const items = rows.map((row: any) => {
      const snapshot = JSON.parse(row.snapshot_json);
      return {
        id: row.id,
        createdAt: formatDate(row.created_at),
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

    try {
      const id = String(req.params.id || '').trim();
      // 常见误用：客户端把 ":id" 当成字面量传过来
      if (!id || id === ':id') {
        res.status(400).json({ message: 'Invalid id' });
        return;
      }

      const params: any[] = [id];
      let sql = 'SELECT * FROM trigger_logs WHERE id = ?';
      // 普通用户只能看自己的触发记录（避免越权）
      if (user.role !== 'admin') {
        sql += ' AND user_id = ?';
        params.push(user.userId);
      }
      sql += ' LIMIT 1';

      const row = await queryOne<any>(sql, params);

      if (!row) {
        res.status(404).json({ message: 'Not found' });
        return;
      }

      const snapshot = safeJsonParse<any>((row as any).snapshot_json, null);
      const item = {
        id: row.id,
        createdAt: formatDate(row.created_at),
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

      // 外部行情服务可能失败：这里兜底为空数组，避免接口整体 500
      let klineRaw: any[] = [];
      try {
        const got = await fetchRecentPriceData(item.symbol, '1');
        klineRaw = Array.isArray(got) ? got : [];
      } catch {
        klineRaw = [];
      }

      const settled = await Promise.allSettled(
        klineRaw.map(async (k) => {
          let indicator: any = null;
          try {
            indicator = await calculateIndicatorSnapshot(item.symbol, Number((k as any).close));
          } catch {
            indicator = null;
          }
          return {
            date: (k as any).time,
            open: (k as any).open,
            close: (k as any).close,
            high: (k as any).high,
            low: (k as any).low,
            volume: (k as any).volume,
            indicator,
          };
        }),
      );

      const kline = settled
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .map((r) => r.value);

      res.json({ item: { ...item, kline } });
    } catch (e: any) {
      res.status(500).json({ message: 'Internal Server Error', error: String(e?.message || e || '') });
    }
  });
}
