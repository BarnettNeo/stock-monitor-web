import type { Express, Request, Response } from 'express';

import { requireAuth } from '../auth';
import { getDb } from '../db';
import { fetchStockDataBatch } from '../engine';
import { formatDate } from '../utils';

function getLocalDayRangeUtcIso(): { startIso: string; endIso: string } {
  const now = new Date();
  const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const endLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { startIso: startLocal.toISOString(), endIso: endLocal.toISOString() };
}

function uniqueSymbolsFromEnabledStrategies(rows: any[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const enabled = Number((row as any).enabled) === 1;
    if (!enabled) continue;
    const raw = typeof (row as any).symbols === 'string' ? String((row as any).symbols) : '';
    for (const s of raw.split(',')) {
      const trimmed = s.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return Array.from(set);
}

function toHourBuckets(hourCountMap: Map<string, number>, targetHours: string[]): { time: string; count: number }[] {
  return targetHours.map((h) => ({ time: h, count: hourCountMap.get(h) || 0 }));
}

export function registerDashboardRoutes(app: Express): void {
  // 大屏聚合数据：
  // - KPI：运行中策略/今日触发/推送成功率/监控股票数
  // - 最新触发：用于滚动列表
  // - 趋势：按小时聚合（00:00 ~ 23:00）
  // - watchlist：从启用策略聚合 symbols 后取 TopN 并补齐报价
  app.get('/api/dashboard/screen', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const db = await getDb();

    const isAdmin = user.role === 'admin';
    const userId = user.userId

    const { startIso, endIso } = getLocalDayRangeUtcIso();

    let strategyWhere = isAdmin ? '' : 'WHERE user_id = ?';
    const strategyParams = isAdmin ? [] : [userId];

    const strategyStmt = db.prepare(`SELECT id, enabled, symbols FROM strategies ${strategyWhere}`);
    strategyStmt.bind(strategyParams);
    const strategyRows: any[] = [];
    while (strategyStmt.step()) {
      strategyRows.push(strategyStmt.getAsObject());
    }
    strategyStmt.free();

    const runningStrategies = strategyRows.filter((r) => Number((r as any).enabled) === 1).length;
    const uniqueSymbols = uniqueSymbolsFromEnabledStrategies(strategyRows);

    const since = typeof req.query.since === 'string' ? String(req.query.since).trim() : '';

    let logWhere = 'WHERE created_at >= ? AND created_at < ?';
    const logParams: any[] = [startIso, endIso];
    if (!isAdmin) {
      logWhere += ' AND user_id = ?';
      logParams.push(userId);
    }

    const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM trigger_logs ${logWhere}`);
    countStmt.bind(logParams);
    const todayTriggers = countStmt.step() ? Number((countStmt.getAsObject() as any).cnt || 0) : 0;
    countStmt.free();

    const pushStmt = db.prepare(
      `SELECT
        SUM(CASE WHEN send_status IN ('SENT','FAILED') THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN send_status = 'SENT' THEN 1 ELSE 0 END) AS success
      FROM trigger_logs ${logWhere}`,
    );
    pushStmt.bind(logParams);
    const pushRow = pushStmt.step() ? (pushStmt.getAsObject() as any) : null;
    pushStmt.free();
    const pushTotal = pushRow ? Number(pushRow.total || 0) : 0;
    const pushSuccess = pushRow ? Number(pushRow.success || 0) : 0;
    const pushSuccessRate = pushTotal > 0 ? pushSuccess / pushTotal : undefined;

    const latestStmt = db.prepare(
      `SELECT id, created_at, symbol, stock_name, reason
       FROM trigger_logs ${logWhere}
       ORDER BY created_at DESC
       LIMIT 20`,
    );
    latestStmt.bind(logParams);
    const latestTriggers: any[] = [];
    let latestCreatedAtIso: string | null = null;
    while (latestStmt.step()) {
      const r: any = latestStmt.getAsObject();
      if (!latestCreatedAtIso) latestCreatedAtIso = String(r.created_at || '') || null;
      latestTriggers.push({
        id: String(r.id),
        createdAt: formatDate(String(r.created_at || '')),
        symbol: String(r.symbol || ''),
        stockName: r.stock_name ? String(r.stock_name) : undefined,
        reason: String(r.reason || ''),
      });
    }
    latestStmt.free();

    let deltaTriggers: any[] = [];
    if (since) {
      const deltaStmt = db.prepare(
        `SELECT id, created_at, symbol, stock_name, reason
         FROM trigger_logs
         ${logWhere} AND created_at > ?
         ORDER BY created_at DESC
         LIMIT 50`,
      );
      deltaStmt.bind([...logParams, since]);
      while (deltaStmt.step()) {
        const r: any = deltaStmt.getAsObject();
        deltaTriggers.push({
          id: String(r.id),
          createdAt: formatDate(String(r.created_at || '')),
          symbol: String(r.symbol || ''),
          stockName: r.stock_name ? String(r.stock_name) : undefined,
          reason: String(r.reason || ''),
        });
      }
      deltaStmt.free();
    }

    const hourCountMap = new Map<string, number>();
    const trendStmt = db.prepare(`SELECT created_at FROM trigger_logs ${logWhere}`);
    trendStmt.bind(logParams);
    while (trendStmt.step()) {
      const r: any = trendStmt.getAsObject();
      const iso = String(r.created_at || '');
      const d = new Date(iso);
      if (isNaN(d.getTime())) continue;
      const hh = String(d.getHours()).padStart(2, '0');
      const key = `${hh}:00`;
      hourCountMap.set(key, (hourCountMap.get(key) || 0) + 1);
    }
    trendStmt.free();

    const targetHours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    const todayTrend = toHourBuckets(hourCountMap, targetHours);

    const watchCodes = uniqueSymbols.slice(0, 12);
    let watchlist: any[] = watchCodes.map((code) => ({ code }));
    if (watchCodes.length > 0) {
      try {
        const stocks = await fetchStockDataBatch(watchCodes);
        watchlist = stocks.map((s) => ({
          code: s.code,
          name: s.name,
          currentPrice: s.currentPrice,
          changePercent: s.changePercent,
        }));
      } catch {
        watchlist = watchCodes.map((code) => ({ code }));
      }
    }

    res.json({
      serverTime: formatDate(new Date()),
      serverTimeIso: new Date().toISOString(),
      kpis: {
        runningStrategies,
        todayTriggers,
        pushSuccessRate,
        monitoredSymbols: uniqueSymbols.length,
      },
      latestTriggers,
      deltaTriggers,
      todayTrend,
      watchlist,
      latestTriggerDetailId: latestTriggers[0]?.id,
      cursor: {
        latestCreatedAt: latestTriggers[0]?.createdAt || null,
        latestCreatedAtIso,
      },
    });
  });
}
