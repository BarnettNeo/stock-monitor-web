import type { Express, Request, Response } from 'express';

import { requireAuth } from '../auth';
import { getDb } from '../db';
import { fetchStockDataBatch } from '../engine';
import { formatDate } from '../utils';

// 大屏数据接口需要按“当天”聚合 trigger_logs。
// trigger_logs.created_at 使用 ISO 字符串（UTC，如 2026-03-17T10:20:30.000Z）。
// 因此按天过滤时必须使用 UTC 日期（toISOString().slice(0,10)），否则会出现“今天看不到数据”的问题。
function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
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

    const today = getTodayStr();

    const strategyStmt = db.prepare('SELECT id, enabled, symbols FROM strategies');
    const strategyRows: any[] = [];
    while (strategyStmt.step()) {
      strategyRows.push(strategyStmt.getAsObject());
    }
    strategyStmt.free();

    const runningStrategies = strategyRows.filter((r) => Number((r as any).enabled) === 1).length;
    const uniqueSymbols = uniqueSymbolsFromEnabledStrategies(strategyRows);

    const since = typeof req.query.since === 'string' ? String(req.query.since).trim() : '';

    const logWhere = 'WHERE substr(created_at,1,10) = ?';
    const logParams: any[] = [today];

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
    while (latestStmt.step()) {
      const r: any = latestStmt.getAsObject();
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

    const trendStmt = db.prepare(
      `SELECT substr(created_at,12,2) AS hh, COUNT(*) AS cnt
       FROM trigger_logs ${logWhere}
       GROUP BY hh`,
    );
    trendStmt.bind(logParams);
    const hourCountMap = new Map<string, number>();
    while (trendStmt.step()) {
      const r: any = trendStmt.getAsObject();
      const hh = String(r.hh || '00').padStart(2, '0');
      hourCountMap.set(`${hh}:00`, Number(r.cnt || 0));
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
      },
    });
  });
}
