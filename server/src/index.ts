import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';

import { getDb, persist } from './db';
import { runStrategyOnce, type Strategy, fetchStockDataBatch } from './engine';
import { notifyBySubscription, type Subscription as NotifySubscription } from './notify';
import { buildNotifyPayload } from './message-templates';
import { openapiDoc } from './openapi';

/**
 * server 主入口：
 * - 提供策略/订阅/触发日志的 REST API
 * - 通过内置 scheduler 周期性扫描策略：触发后推送到绑定订阅，并写入 trigger_logs
 */
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3001);

function nowIso(): string {
  return new Date().toISOString();
}

function intToBool(v: any): boolean {
  return Number(v) === 1;
}

function boolToInt(v: boolean): number {
  return v ? 1 : 0;
}

function formatZodError(error: any): string {
  if (!error?.issues) return error?.message || 'Invalid input';

  const messages = error.issues.map((issue: any) => {
    const path = issue.path.join('.');
    const validation = issue.validation || issue.code;

    switch (validation) {
      case 'url':
        return `${path === 'webhookUrl' ? 'Webhook URL' : 'URL'} 格式不正确`;
      case 'min':
        if (path === 'name') return '名称不能为空';
        if (path === 'symbols') return '股票列表不能为空';
        if (path === 'intervalMs') return '扫描间隔必须 >= 1000ms';
        if (path === 'cooldownMinutes') return '冷却时间必须 >= 1 分钟';
        if (path === 'priceAlertPercent') return '涨跌幅阈值必须 >= 0.1%';
        return `${path} 太小`;
      case 'invalid_type':
        return `${path} 类型错误`;
      case 'invalid_string':
        if (issue.validation === 'url') return `${path === 'webhookUrl' ? 'Webhook URL' : 'URL'} 格式不正确`;
        return `${path} 字符串格式错误`;
      default:
        return `${path}: ${issue.message}`;
    }
  });

  return messages.join('; ');
}

function handleApiError(error: any): { status: number; message: string } {
  if (error instanceof z.ZodError) {
    console.error('Validation error:', error);
    return { status: 400, message: formatZodError(error) };
  } else {
    console.error('API error:', error);
    return { status: 500, message: 'Internal Server Error' };
  }
}

const StrategyInputSchema = z.object({
  userId: z.string().nullable().optional(),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  symbols: z.string().min(1),
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

const SubscriptionInputSchema = z.object({
  userId: z.string().optional(),
  name: z.string().min(1),
  type: z.enum(['dingtalk', 'wecom_robot', 'wecom_app']),
  enabled: z.boolean().default(true),
  webhookUrl: z.string().url().optional(),
  keyword: z.string().optional(),
  wecomApp: z
    .object({
      corpId: z.string().min(1),
      corpSecret: z.string().min(1),
      agentId: z.number().int().positive(),
      toUser: z.string().optional(),
      toParty: z.string().optional(),
      toTag: z.string().optional(),
    })
    .optional(),
});

function rowToStrategy(row: any): any {
  const subscriptionIds: string[] = row.subscription_ids_json
    ? JSON.parse(String(row.subscription_ids_json))
    : [];

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    enabled: intToBool(row.enabled),
    symbols: row.symbols,
    subscriptionIds,
    alertMode: (row.alert_mode === 'target' ? 'target' : 'percent'),
    targetPriceUp: typeof row.target_price_up === 'number' ? row.target_price_up : (row.target_price_up ? Number(row.target_price_up) : undefined),
    targetPriceDown: typeof row.target_price_down === 'number' ? row.target_price_down : (row.target_price_down ? Number(row.target_price_down) : undefined),
    intervalMs: Number(row.interval_ms),
    cooldownMinutes: Number(row.cooldown_minutes),
    priceAlertPercent: Number(row.price_alert_percent),
    enableMacdGoldenCross: intToBool(row.enable_macd_golden_cross),
    enableRsiOversold: intToBool(row.enable_rsi_oversold),
    enableRsiOverbought: intToBool(row.enable_rsi_overbought),
    enableMovingAverages: intToBool(row.enable_moving_averages),
    enablePatternSignal: intToBool(row.enable_pattern_signal),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSubscription(row: any): any {
  const wecomApp =
    row.wecom_app_corp_id && row.wecom_app_corp_secret && row.wecom_app_agent_id
      ? {
          corpId: row.wecom_app_corp_id,
          corpSecret: row.wecom_app_corp_secret,
          agentId: Number(row.wecom_app_agent_id),
          toUser: row.wecom_app_to_user || undefined,
          toParty: row.wecom_app_to_party || undefined,
          toTag: row.wecom_app_to_tag || undefined,
        }
      : undefined;

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    type: row.type,
    enabled: intToBool(row.enabled),
    webhookUrl: row.webhook_url || undefined,
    keyword: row.keyword || undefined,
    wecomApp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// OpenAPI 文档：
// - /openapi.json：供 Postman/Apifox 导入
// - /api-docs：Swagger UI 可视化页面
app.get('/openapi.json', (_req: Request, res: Response) => {
  res.json(openapiDoc);
});
// 修复 TS2769 类型不匹配问题：将中间件强制转换为 any 以绕过过严格的 Express 路由类型检查
app.use('/api-docs', (swaggerUi.serve as any), (swaggerUi.setup(openapiDoc as any) as any));

/**
 * 策略管理 API
 */
app.get('/api/strategies', async (_req: Request, res: Response) => {
  const db = await getDb();
  const result = db.exec('SELECT * FROM strategies ORDER BY updated_at DESC');
  const rows = result[0]?.values || [];
  const cols = result[0]?.columns || [];
  const items = rows
    .map((v: any[]) => Object.fromEntries(v.map((x: any, i: number) => [cols[i], x])))
    .map(rowToStrategy);

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

  // 为每个策略添加股票名称
  const itemsWithNames = items.map((item: any) => ({
    ...item,
    alertMode: item.alertMode || 'percent',
    stockNames: item.symbols
      ? item.symbols.split(',').map((s: string) => {
          const trimmed = s.trim().toLowerCase();
          return stockNames[trimmed] || '';
        }).join(',')
      : '',
  }));

  res.json({ items: itemsWithNames });
});

app.get('/api/strategies/:id', async (req: Request, res: Response) => {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM strategies WHERE id = ?');
  stmt.bind([req.params.id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ item: rowToStrategy(row) });
});

app.post('/api/strategies', async (req: Request, res: Response) => {
  try {
    const parsed = StrategyInputSchema.parse(req.body);
    const id = crypto.randomUUID();
    const ts = nowIso();
    const db = await getDb();

    const subscriptionIdsJson = parsed.subscriptionIds && parsed.subscriptionIds.length > 0
      ? JSON.stringify(parsed.subscriptionIds)
      : null;

    db.run(
      `INSERT INTO strategies (
        id,user_id,name,enabled,symbols,subscription_ids_json,alert_mode,target_price_up,target_price_down,interval_ms,cooldown_minutes,price_alert_percent,
        enable_macd_golden_cross,enable_rsi_oversold,enable_rsi_overbought,enable_moving_averages,enable_pattern_signal,
        created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        parsed.userId || null,
        parsed.name,
        boolToInt(parsed.enabled),
        parsed.symbols,
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
    console.error('POST /api/strategies error:', error);
    res.status(400).json({ message: formatZodError(error) });
  }
});

app.put('/api/strategies/:id', async (req: Request, res: Response) => {
  try {
    const parsed = StrategyInputSchema.parse(req.body);
    const ts = nowIso();
    const db = await getDb();

    const subscriptionIdsJson = parsed.subscriptionIds && parsed.subscriptionIds.length > 0
      ? JSON.stringify(parsed.subscriptionIds)
      : null;

    db.run(
      `UPDATE strategies SET
        user_id=?,name=?,enabled=?,symbols=?,alert_mode=?,target_price_up=?,target_price_down=?,interval_ms=?,cooldown_minutes=?,price_alert_percent=?,
        enable_macd_golden_cross=?,enable_rsi_oversold=?,enable_rsi_overbought=?,enable_moving_averages=?,enable_pattern_signal=?,
        subscription_ids_json=?,updated_at=?
      WHERE id=?`,
      [
        parsed.userId || null,
        parsed.name,
        boolToInt(parsed.enabled),
        parsed.symbols,
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
  const db = await getDb();
  db.run('DELETE FROM strategies WHERE id = ?', [req.params.id]);
  persist();
  res.json({ ok: true });
});

/**
 * 订阅管理 API
 */
app.get('/api/subscriptions', async (_req: Request, res: Response) => {
  const db = await getDb();
  const result = db.exec('SELECT * FROM subscriptions ORDER BY updated_at DESC');
  const rows = result[0]?.values || [];
  const cols = result[0]?.columns || [];
  const items = rows
    .map((v: any[]) => Object.fromEntries(v.map((x: any, i: number) => [cols[i], x])))
    .map(rowToSubscription);
  res.json({ items });
});

app.get('/api/subscriptions/:id', async (req: Request, res: Response) => {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM subscriptions WHERE id = ?');
  stmt.bind([req.params.id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ item: rowToSubscription(row) });
});

app.post('/api/subscriptions', async (req: Request, res: Response) => {
  try {
    const parsed = SubscriptionInputSchema.parse(req.body);
    const id = crypto.randomUUID();
    const ts = nowIso();
    const db = await getDb();

    db.run(
      `INSERT INTO subscriptions (
        id,user_id,name,type,enabled,webhook_url,keyword,
        wecom_app_corp_id,wecom_app_corp_secret,wecom_app_agent_id,wecom_app_to_user,wecom_app_to_party,wecom_app_to_tag,
        created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        parsed.userId || null,
        parsed.name,
        parsed.type,
        boolToInt(parsed.enabled),
        parsed.webhookUrl || null,
        parsed.keyword || null,
        parsed.wecomApp?.corpId || null,
        parsed.wecomApp?.corpSecret || null,
        parsed.wecomApp?.agentId || null,
        parsed.wecomApp?.toUser || null,
        parsed.wecomApp?.toParty || null,
        parsed.wecomApp?.toTag || null,
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

app.put('/api/subscriptions/:id', async (req: Request, res: Response) => {
  try {
    const parsed = SubscriptionInputSchema.parse(req.body);
    const ts = nowIso();
    const db = await getDb();

    db.run(
      `UPDATE subscriptions SET
        user_id=?,name=?,type=?,enabled=?,webhook_url=?,keyword=?,
        wecom_app_corp_id=?,wecom_app_corp_secret=?,wecom_app_agent_id=?,wecom_app_to_user=?,wecom_app_to_party=?,wecom_app_to_tag=?,
        updated_at=?
      WHERE id=?`,
      [
        parsed.userId || null,
        parsed.name,
        parsed.type,
        boolToInt(parsed.enabled),
        parsed.webhookUrl || null,
        parsed.keyword || null,
        parsed.wecomApp?.corpId || null,
        parsed.wecomApp?.corpSecret || null,
        parsed.wecomApp?.agentId || null,
        parsed.wecomApp?.toUser || null,
        parsed.wecomApp?.toParty || null,
        parsed.wecomApp?.toTag || null,
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

app.delete('/api/subscriptions/:id', async (req: Request, res: Response) => {
  const db = await getDb();
  db.run('DELETE FROM subscriptions WHERE id = ?', [req.params.id]);
  persist();
  res.json({ ok: true });
});

// 触发日志查询
app.get('/api/trigger-logs', async (_req: Request, res: Response) => {
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

const lastFired = new Map<string, number>();

/**
 * 将触发事件格式化为 markdown，便于机器人/企微应用统一发送。
 * - markdown 内会带上 snapshot（JSON）方便后续排查“为什么触发”。
 */
function buildMarkdownFromEvent(ev: any): { title: string; markdown: string } {
  return buildNotifyPayload(ev, 'dingtalk');
}

// 扫描一次，检查所有订阅是否满足条件
async function scanOnce(): Promise<void> {
  const db = await getDb();

  // 读取所有订阅（后续按策略的 subscriptionIds 过滤）
  const subsResult = db.exec('SELECT * FROM subscriptions WHERE enabled = 1');
  const subRows = subsResult[0]?.values || [];
  const subCols = subsResult[0]?.columns || [];
  const allSubs = subRows
    .map((v: any[]) => Object.fromEntries(v.map((x: any, i: number) => [subCols[i], x])))
    .map(rowToSubscription) as NotifySubscription[];
  const subMap = new Map(allSubs.map(s => [s.id, s]));

  const strategyResult = db.exec('SELECT * FROM strategies WHERE enabled = 1');
  const sRows = strategyResult[0]?.values || [];
  const sCols = strategyResult[0]?.columns || [];
  const strategies = sRows
    .map((v: any[]) => Object.fromEntries(v.map((x: any, i: number) => [sCols[i], x])))
    .map((row: any) => {
      const symbols = String(row.symbols)
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);

      const subscriptionIds: string[] = row.subscription_ids_json
        ? JSON.parse(String(row.subscription_ids_json))
        : [];

      const strategy: Strategy = {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        enabled: intToBool(row.enabled),
        symbols,
        subscriptionIds,
        alertMode: (row.alert_mode === 'target' ? 'target' : 'percent'),
        targetPriceUp: typeof row.target_price_up === 'number' ? row.target_price_up : (row.target_price_up ? Number(row.target_price_up) : undefined),
        targetPriceDown: typeof row.target_price_down === 'number' ? row.target_price_down : (row.target_price_down ? Number(row.target_price_down) : undefined),
        intervalMs: Number(row.interval_ms),
        cooldownMinutes: Number(row.cooldown_minutes),
        priceAlertPercent: Number(row.price_alert_percent),
        enableMacdGoldenCross: intToBool(row.enable_macd_golden_cross),
        enableRsiOversold: intToBool(row.enable_rsi_oversold),
        enableRsiOverbought: intToBool(row.enable_rsi_overbought),
        enableMovingAverages: intToBool(row.enable_moving_averages),
        enablePatternSignal: intToBool(row.enable_pattern_signal),
      };

      return strategy;
    });

  for (const strategy of strategies) {
    try {
      const events = await runStrategyOnce(strategy);
      for (const ev of events) {
        // 冷却：避免同一策略对同一股票/原因高频重复推送
        const key = `${strategy.id}:${ev.symbol}:${ev.reason}`;
        const now = Date.now();
        const last = lastFired.get(key) || 0;
        if (now - last < strategy.cooldownMinutes * 60 * 1000) continue;

        lastFired.set(key, now);

        // 如果策略未绑定订阅：只落库一条 NO_SUBSCRIPTION 记录
        // 如果已绑定订阅：对每个订阅分别发送、分别落库（便于看每个渠道的结果）
        const subIds = (strategy as any).subscriptionIds as string[] | undefined;
        const targets = (subIds && subIds.length > 0)
          ? subIds.map(id => subMap.get(id)).filter(Boolean)
          : [undefined];

        for (const sub of targets) {
          const payload = sub
            ? buildNotifyPayload(ev, sub.type)
            : buildMarkdownFromEvent(ev);
          const sendResult = sub
            ? await notifyBySubscription(sub, payload)
            : { ok: true };

          const id = crypto.randomUUID();
          db.run(
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
              sendResult.ok ? null : (sendResult.error || 'unknown error'),
              nowIso(),
            ],
          );
        }
      }
    } catch (e) {
      console.error('scanOnce strategy error:', strategy.id, e);
    }
  }

  persist();
}

async function startScheduler(): Promise<void> {
  console.log('扫码策略时间间隔:', process.env.SCAN_INTERVAL_MS);
  const intervalMs = Number(process.env.SCAN_INTERVAL_MS || 15000);
  await scanOnce();
  setInterval(() => {
    scanOnce().catch(err => console.error('scanOnce error:', err));
  }, intervalMs);
}

app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
  startScheduler().catch(err => console.error('scheduler init error:', err));
});
