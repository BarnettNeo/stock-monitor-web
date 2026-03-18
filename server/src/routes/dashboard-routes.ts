import type { Express, Request, Response } from 'express';

import axios from 'axios';
import { requireAuth } from '../auth';
import { getDb } from '../db';
import { fetchKLineData, fetchStockDataBatch } from '../engine';
import { formatDate } from '../utils';


// 获取本地日期范围的 UTC ISO 字符串。
function getLocalDayRangeUtcIso(): { startIso: string; endIso: string } {
  const now = new Date();
  const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const endLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { startIso: startLocal.toISOString(), endIso: endLocal.toISOString() };
}

// 从启用策略中提取唯一股票代码。
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

// 将小时计数映射转换为目标小时的数组。
function toHourBuckets(hourCountMap: Map<string, number>, targetHours: string[]): { time: string; count: number }[] {
  return targetHours.map((h) => ({ time: h, count: hourCountMap.get(h) || 0 }));
}

type CacheEntry<T> = { expiresAt: number; data: T };
const hotMoversCache = new Map<string, CacheEntry<any>>();

function clampInt(v: any, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// 并发映射函数，限制并发数。
async function mapWithConcurrency<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const safeLimit = Math.max(1, Math.min(16, Math.trunc(limit)));
  const results: U[] = new Array(items.length) as any;
  let idx = 0;

  const workers = Array.from({ length: safeLimit }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });

  await Promise.all(workers);
  return results;
}

type SinaMarketNodeItem = {
  symbol?: string;
  name?: string;
  trade?: string;
  changepercent?: number | string;
  amount?: number | string;
};

// 从新浪股票节点获取顶部股票列表。
async function fetchSinaMarketNodeTop(params: {
  node: string;
  sort: string;
  asc: 0 | 1;
  page: number;
  num: number;
}): Promise<SinaMarketNodeItem[]> {
  const url =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';

  const res = await axios.get(url, {
    timeout: 10000,
    responseType: 'text',
    transformResponse: [(x) => x],
    params: {
      page: params.page,
      num: params.num,
      sort: params.sort,
      asc: params.asc,
      node: params.node,
      symbol: '',
      _s_r_a: 'init',
    },
    headers: {
      Referer: 'https://finance.sina.com.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  try {
    const parsed = JSON.parse(String(res.data || '[]'));
    return Array.isArray(parsed) ? (parsed as SinaMarketNodeItem[]) : [];
  } catch {
    return [];
  }
}

// 计算市场热门股票。
async function computeMarketHotMovers(params: {
  windowDays: number;
  limit: number;
  universeLimit: number;
}): Promise<{ windowDays: number; limit: number; universeLimit: number; gainers: any[]; losers: any[] }> {
  const windowDays = clampInt(params.windowDays, 1, 10, 3);
  const limit = clampInt(params.limit, 1, 50, 10);
  const universeLimit = clampInt(params.universeLimit, 50, 2000, 300);

  const candidates = await fetchSinaMarketNodeTop({
    node: 'hs_a',
    sort: 'amount',
    asc: 0,
    page: 1,
    num: universeLimit,
  });

  const symbolInfos = candidates
    .map((x) => ({
      symbol: x.symbol ? String(x.symbol).trim() : '',
      name: x.name ? String(x.name) : undefined,
      currentPrice: x.trade !== undefined ? Number(x.trade) : undefined,
      changePercent: x.changepercent !== undefined ? Number(x.changepercent) : undefined,
    }))
    .filter((x) => Boolean(x.symbol));

  const symbolInfoMap = new Map(symbolInfos.map((x) => [x.symbol, x]));
  const symbols = symbolInfos.map((x) => x.symbol);

  const returns = await mapWithConcurrency(symbols, 8, async (symbol) => {
    try {
      const prices = await fetchKLineData(symbol, '240', Math.max(10, windowDays + 2));
      if (!prices.length) return null;
      const closes = prices.map((p) => p.close).filter((c) => Number.isFinite(c) && c > 0);
      const need = windowDays + 1;
      if (closes.length < need) return null;
      const base = closes[closes.length - need];
      const last = closes[closes.length - 1];
      if (!base || !Number.isFinite(base) || base <= 0) return null;
      const pct = ((last - base) / base) * 100;
      return { symbol, returnNd: Number(pct.toFixed(2)) };
    } catch {
      return null;
    }
  });

  const valid = returns.filter((x): x is { symbol: string; returnNd: number } => Boolean(x));
  valid.sort((a, b) => b.returnNd - a.returnNd);

  const gainers = valid.slice(0, limit).map((x) => {
    const info = symbolInfoMap.get(x.symbol);
    return {
      code: x.symbol,
      name: info?.name,
      currentPrice: info?.currentPrice,
      changePercent: info?.changePercent,
      returnNd: x.returnNd,
    };
  });

  const losers = valid
    .slice(-limit)
    .reverse()
    .map((x) => {
      const info = symbolInfoMap.get(x.symbol);
      return {
        code: x.symbol,
        name: info?.name,
        currentPrice: info?.currentPrice,
        changePercent: info?.changePercent,
        returnNd: x.returnNd,
      };
    });

  return { windowDays, limit, universeLimit, gainers, losers };
}

// 获取缓存的热门股票。
async function getMarketHotMoversCached(params: {
  windowDays: number;
  limit: number;
  universeLimit: number;
}): Promise<any> {
  const windowDays = clampInt(params.windowDays, 1, 10, 3);
  const limit = clampInt(params.limit, 1, 50, 10);
  const universeLimit = clampInt(params.universeLimit, 50, 2000, 300);

  const cacheKey = `mkt:w${windowDays}:l${limit}:u${universeLimit}`;
  const cached = hotMoversCache.get(cacheKey);
  const nowMs = Date.now();
  if (cached && cached.expiresAt > nowMs) {
    return { ...cached.data, cached: true };
  }

  const core = await computeMarketHotMovers({ windowDays, limit, universeLimit });
  const payload = {
    serverTime: formatDate(new Date()),
    windowDays: core.windowDays,
    limit: core.limit,
    gainers: core.gainers,
    losers: core.losers,
    cached: false,
  };

  hotMoversCache.set(cacheKey, { expiresAt: nowMs + 60 * 60 * 1000, data: payload });
  return payload;
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
    const userId = user.userId;

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

    const hotMovers = await getMarketHotMoversCached({ windowDays: 3, limit: 10, universeLimit: 300 });

    res.json({
      serverTime: formatDate(new Date()),
      serverTimeIso: new Date().toISOString(),
      kpis: {
        runningStrategies,
        todayTriggers,
        pushSuccessRate,
        monitoredSymbols: uniqueSymbols.length,
      },
      focusSymbols: uniqueSymbols,
      latestTriggers,
      deltaTriggers,
      todayTrend,
      watchlist,
      hotMovers,
      latestTriggerDetailId: latestTriggers[0]?.id,
      cursor: {
        latestCreatedAt: latestTriggers[0]?.createdAt || null,
        latestCreatedAtIso,
      },
    });
  });

  // 获取热门股票 movers 列表。
  app.get('/api/dashboard/hot-movers', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const windowDays = clampInt(req.query.windowDays, 1, 10, 3);
    const limit = clampInt(req.query.limit, 1, 50, 10);
    const payload = await getMarketHotMoversCached({ windowDays, limit, universeLimit: 300 });
    res.json(payload);
  });
}
