import crypto from 'node:crypto';
import axios from 'axios';

import { execute, query } from './db';
import { runStrategyOnce, type Strategy } from './engine';
import { notifyBySubscription, type Subscription as NotifySubscription } from './notify';
import { buildNotifyPayload } from './message-templates';
import { intToBool, nowIso } from './utils';
import { rowToSubscription } from './mappers';

type StrategyRow = any;

type NewsIngestResult = {
  ok: boolean;
  fetched?: number;
  processed?: number;
  inserted?: number;
  errors?: string[];
  meta?: any;
};

export type SchedulerHandle = {
  stop: () => void;
};

type AttributionCitation = {
  title: string;
  source?: string;
  url?: string;
  publishedAt?: string;
};

type AttributionResult = {
  summary: string;
  followUps?: string[];
  confidence?: number;
  citations?: AttributionCitation[];
  meta?: any;
};

function buildMarkdownFromEvent(ev: any): { title: string; markdown: string } {
  return buildNotifyPayload(ev, 'dingtalk');
}

function getAgentsBaseUrl(): string {
  const raw = String(process.env.AGENTS_BASE_URL || 'http://127.0.0.1:8009').trim();
  return raw.replace(/\/+$/, '');
}

// 解析股票代码列表
function parseSymbolList(raw: string): string[] {
  const arr = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(arr.map((s) => s.toLowerCase())));
}

// 运行新闻采集任务
async function runNewsIngestOnce(traceId: string): Promise<NewsIngestResult> {
  const baseUrl = getAgentsBaseUrl();
  let sinceMinutes = Number(process.env.NEWS_INGEST_SINCE_MINUTES || 180);
  const maxItems = Number(process.env.NEWS_INGEST_MAX_ITEMS || 30);

  let symbols: string[] = [];
  const explicit = String(process.env.NEWS_INGEST_SYMBOLS || '').trim();
  if (explicit) {
    symbols = parseSymbolList(explicit);
  } else {
    const rows = await query<any>('SELECT * FROM strategies WHERE enabled = 1');
    const set = new Set<string>();
    for (const row of rows) {
      const symList = String(row.symbols || '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      for (const s of symList) {
        if (set.size >= 200) break;
        set.add(String(s).toLowerCase());
      }
      if (set.size >= 200) break;
    }
    symbols = Array.from(set);
  }

  // Auto incremental window: if sinceMinutes <= 0, use last successful run interval.
  if (!Number.isFinite(sinceMinutes) || sinceMinutes <= 0) {
    try {
      const rows = await query<any>(
        `SELECT finished_at FROM news_ingest_runs WHERE ok = 1 ORDER BY finished_at DESC LIMIT 1`,
      );
      const last = rows && rows[0] ? String(rows[0].finished_at || '') : '';
      if (last) {
        const t = Date.parse(last);
        if (!Number.isNaN(t)) {
          const deltaMin = Math.ceil((Date.now() - t) / 60000);
          sinceMinutes = Math.max(5, Math.min(deltaMin, 24 * 60));
        }
      }
    } catch {
      sinceMinutes = 180;
    }
  }

  const payload = {
    symbols,
    sinceMinutes,
    maxItems,
    dryRun: false,
    feeds: [],
  };

  const startedAt = nowIso();
  try {
    const r = await axios.post(`${baseUrl}/a2a/ingest/run`, payload, {
      timeout: 120000,
      headers: { 'x-trace-id': traceId },
    });
    const data = (r.data || {}) as any;
    const finishedAt = nowIso();

    const ok = data.ok !== false;
    const fetched = Number(data.fetched || 0);
    const processed = Number(data.processed || 0);
    const inserted = Number(data.inserted || 0);
    const errors = Array.isArray(data.errors) ? data.errors.map((e: any) => String(e)) : [];
    const meta = data.meta || {};
    const trace = String(meta?.traceId || traceId);

    await execute(
      `INSERT INTO news_ingest_runs (
        id, trace_id, symbols, since_minutes, max_items, ok, fetched, processed, inserted, errors_json, meta_json, started_at, finished_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        crypto.randomUUID(),
        trace,
        symbols.length ? JSON.stringify(symbols) : null,
        sinceMinutes,
        maxItems,
        ok ? 1 : 0,
        fetched,
        processed,
        inserted,
        errors.length ? JSON.stringify(errors.slice(0, 50)) : null,
        meta ? JSON.stringify(meta) : null,
        startedAt,
        finishedAt,
      ],
    );

    return { ok, fetched, processed, inserted, errors, meta };
  } catch (e: any) {
    const finishedAt = nowIso();
    const err = String(e?.message || e);
    try {
      await execute(
        `INSERT INTO news_ingest_runs (
          id, trace_id, symbols, since_minutes, max_items, ok, fetched, processed, inserted, errors_json, meta_json, started_at, finished_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          crypto.randomUUID(),
          traceId,
          symbols.length ? JSON.stringify(symbols) : null,
          sinceMinutes,
          maxItems,
          0,
          0,
          0,
          0,
          JSON.stringify([err]),
          null,
          startedAt,
          finishedAt,
        ],
      );
    } catch {
      // ignore db errors
    }
    return { ok: false, errors: [err] };
  }
}

async function analyzeAttribution(
  userId: string | null | undefined,
  ev: any,
  windowMinutes: number = 10,
): Promise<AttributionResult | null> {
  try {
    const baseUrl = getAgentsBaseUrl();
    const payload = {
      symbol: String(ev.symbol || ''),
      stockName: ev.stockName || ev.snapshot?.stock?.name || '',
      eventReason: String(ev.reason || ''),
      snapshot: ev.snapshot || null,
      windowMinutes,
      // For future: pass userId for user-level memory retrieval
      userId: userId || null,
    };

    const r = await axios.post(`${baseUrl}/analysis/attribution`, payload, { timeout: 45000 });
    const data = r.data || {};
    if (!data || data.ok === false) return null;

    const summary = String(data.summary || '').trim();
    if (!summary) return null;

    return {
      summary,
      followUps: Array.isArray(data.followUps) ? data.followUps.map((s: any) => String(s)) : undefined,
      confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
      citations: Array.isArray(data.citations)
        ? data.citations
            .map((c: any) => ({
              title: String(c?.title || '').trim(),
              source: c?.source ? String(c.source) : undefined,
              url: c?.url ? String(c.url) : undefined,
              publishedAt: c?.publishedAt ? String(c.publishedAt) : undefined,
            }))
            .filter((c: any) => c.title)
        : undefined,
      meta: data.meta || undefined,
    };
  } catch {
    return null;
  }
}

// 扫描一次：读取启用策略 -> 计算触发事件 -> 对订阅发送并落库 trigger_logs
export async function scanOnce(): Promise<void> {
  const allSubs = (await query<any>('SELECT * FROM subscriptions WHERE enabled = 1'))
    .map(rowToSubscription) as NotifySubscription[];
  const subMap = new Map(allSubs.map((s) => [s.id, s]));

  const strategies = (await query<any>('SELECT * FROM strategies WHERE enabled = 1'))
    .map((row: StrategyRow) => {
      const symbols = String(row.symbols)
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);

      const subscriptionIds: string[] = row.subscription_ids_json ? JSON.parse(String(row.subscription_ids_json)) : [];

      const strategy: Strategy = {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        enabled: intToBool(row.enabled),
        symbols,
        subscriptionIds,
        marketTimeOnly: row.market_time_only === undefined || row.market_time_only === null ? true : intToBool(row.market_time_only),
        alertMode: row.alert_mode === 'target' ? 'target' : 'percent',
        targetPriceUp: typeof row.target_price_up === 'number' ? row.target_price_up : row.target_price_up ? Number(row.target_price_up) : undefined,
        targetPriceDown: typeof row.target_price_down === 'number' ? row.target_price_down : row.target_price_down ? Number(row.target_price_down) : undefined,
        intervalMs: Number(row.interval_ms),
        cooldownMinutes: Number(row.cooldown_minutes),
        priceAlertPercent: Number(row.price_alert_percent),
        enableMacdGoldenCross: intToBool(row.enable_macd_golden_cross),
        enableRsiOversold: intToBool(row.enable_rsi_oversold),
        enableRsiOverbought: intToBool(row.enable_rsi_overbought),
        enableMovingAverages: intToBool(row.enable_moving_averages),
        enableVolumeSignal: row.enable_volume_signal === undefined || row.enable_volume_signal === null
          ? false
          : intToBool(row.enable_volume_signal),
        volumeMultiplier: typeof row.volume_multiplier === 'number'
          ? row.volume_multiplier
          : row.volume_multiplier
            ? Number(row.volume_multiplier)
            : 1.5,
        enablePatternSignal: intToBool(row.enable_pattern_signal),
      };

      return strategy;
    });

  for (const strategy of strategies) {
    try {
      const events = await runStrategyOnce(strategy);
      for (const ev of events) {
        // 归因分析：每个事件做一次，复用到该事件的所有订阅推送
        const attribution = await analyzeAttribution(strategy.userId || null, ev, 10);
        const evForPayload = attribution ? { ...ev, attribution } : ev;

        const subIds = (strategy as any).subscriptionIds as string[] | undefined;
        const targets = subIds && subIds.length > 0 ? subIds.map((id) => subMap.get(id)).filter(Boolean) : [undefined];

        for (const sub of targets) {
          // 每个订阅都单独落一条 trigger_log，便于回看不同渠道的发送结果。
          const payload = sub ? buildNotifyPayload(evForPayload, sub.type) : buildMarkdownFromEvent(evForPayload);
          const sendResult = sub ? await notifyBySubscription(sub, payload) : { ok: true };

          const id = crypto.randomUUID();
          await execute(
            `INSERT INTO trigger_logs (
              id,user_id,strategy_id,subscription_id,symbol,stock_name,reason,snapshot_json,send_status,send_error,created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [
              id,
              strategy.userId || null,
              strategy.id,
              sub ? sub.id : null,
              ev.symbol,
              ev.stockName || null,
              ev.reason,
              JSON.stringify(ev.snapshot),
              sub ? (sendResult.ok ? 'SENT' : 'FAILED') : 'NO_SUBSCRIPTION',
              sendResult.ok ? null : sendResult.error || 'unknown error',
              nowIso(),
            ],
          );

          // 归因报告落库（不影响主流程）
          if (attribution && attribution.summary) {
            const reportId = crypto.randomUUID();
            try {
              await execute(
                `INSERT INTO attribution_reports (
                  id,user_id,trigger_log_id,symbol,stock_name,event_reason,analysis_summary,analysis_json,created_at
                ) VALUES (?,?,?,?,?,?,?,?,?)`,
                [
                  reportId,
                  strategy.userId || null,
                  id,
                  ev.symbol,
                  ev.stockName || null,
                  ev.reason,
                  attribution.summary,
                  JSON.stringify(attribution),
                  nowIso(),
                ],
              );
            } catch (e) {
              // ignore (e.g. table not created yet / duplicate constraint)
              void e;
            }
          }
        }
      }
    } catch (e) {
      console.error('scanOnce strategy error:', strategy.id, e);
    }
  }

}

export async function startScheduler(): Promise<SchedulerHandle> {
  console.log('扫码策略时间间隔:', process.env.SCAN_INTERVAL_MS);
  const intervalMs = Number(process.env.SCAN_INTERVAL_MS || 15000);
  await scanOnce();
  const timer = setInterval(() => {
    scanOnce().catch((err) => console.error('scanOnce error:', err));
  }, intervalMs);

  // News ingest cron/worker (best-effort). Enable by setting NEWS_INGEST_INTERVAL_MS > 0.
  const ingestIntervalMs = Number(process.env.NEWS_INGEST_INTERVAL_MS || 0);
  let ingestTimer: any = null;
  let ingestRunning = false;
  if (ingestIntervalMs > 0) {
    const run = async () => {
      if (ingestRunning) return;
      ingestRunning = true;
      const traceId = crypto.randomUUID();
      try {
        const r = await runNewsIngestOnce(traceId);
        if (!r.ok) console.error('news ingest failed:', traceId, r.errors?.[0] || '');
        else console.log('news ingest ok:', traceId, `inserted=${r.inserted || 0}`);
      } finally {
        ingestRunning = false;
      }
    };
    await run();
    ingestTimer = setInterval(() => {
      run().catch((err) => console.error('news ingest error:', err));
    }, ingestIntervalMs);
  }

  return {
    stop: () => {
      clearInterval(timer);
      if (ingestTimer) clearInterval(ingestTimer);
    },
  };
}
