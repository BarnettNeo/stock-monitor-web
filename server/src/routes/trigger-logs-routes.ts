import type { Express, Request, Response } from 'express';

import { query, queryOne } from '../db';
import { requireAuth } from '../auth';
import { fetchRecentPriceData, calculateIndicatorSnapshot } from '../engine';
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

    const row = await queryOne<any>('SELECT * FROM trigger_logs WHERE id = ? LIMIT 1', [
      req.params.id,
    ]);

    if (!row) {
      res.status(404).json({ message: 'Not found' });
      return;
    }

    const snapshot = JSON.parse((row as any).snapshot_json);
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
