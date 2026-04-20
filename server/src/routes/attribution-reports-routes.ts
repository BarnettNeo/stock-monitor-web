import type { Express, Request, Response } from 'express';

import { requireAuth } from '../auth';
import { query, queryOne } from '../db';
import { createWhereBuilder, addClause, toWhereSql } from '../sql-utils';

function safeJsonParse(s: any): any {
  try {
    if (!s) return null;
    return JSON.parse(String(s));
  } catch {
    return null;
  }
}

export function registerAttributionReportRoutes(app: Express): void {
  // List reports (filter by triggerLogId/symbol)
  app.get('/api/attribution-reports', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const triggerLogId = String(req.query.triggerLogId || '').trim();
    const symbol = String(req.query.symbol || '').trim();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));

    const where = createWhereBuilder();
    if (user.role !== 'admin') {
      addClause(where, 'user_id = ?', user.userId);
    }
    if (triggerLogId) addClause(where, 'trigger_log_id = ?', triggerLogId);
    if (symbol) addClause(where, 'symbol = ?', symbol);
    const { whereSql, params } = toWhereSql(where);

    const rows = await query<any>(
      `SELECT * FROM attribution_reports ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit],
    );
    return res.json({
      ok: true,
      items: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        triggerLogId: r.trigger_log_id,
        symbol: r.symbol,
        stockName: r.stock_name,
        eventReason: r.event_reason,
        summary: r.analysis_summary,
        analysis: safeJsonParse(r.analysis_json),
        createdAt: r.created_at,
      })),
    });
  });

  // Get detail by id
  app.get('/api/attribution-reports/:id', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, message: 'id required' });

    const row = await queryOne<any>('SELECT * FROM attribution_reports WHERE id = ? LIMIT 1', [id]);
    if (!row) return res.status(404).json({ ok: false, message: 'not found' });

    if (user.role !== 'admin' && String(row.user_id) !== user.userId) {
      return res.status(403).json({ ok: false, message: 'forbidden' });
    }

    return res.json({
      ok: true,
      item: {
        id: row.id,
        userId: row.user_id,
        triggerLogId: row.trigger_log_id,
        symbol: row.symbol,
        stockName: row.stock_name,
        eventReason: row.event_reason,
        summary: row.analysis_summary,
        analysis: safeJsonParse(row.analysis_json),
        createdAt: row.created_at,
      },
    });
  });
}

