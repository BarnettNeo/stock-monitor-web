import crypto from 'node:crypto';

import type { Express, Request, Response } from 'express';
import axios from 'axios';
import { z } from 'zod';

import type { AuthedUser } from '../auth';
import { requireAuth } from '../auth';
import { getDb, persist } from '../db';
import { rowToStrategy } from '../mappers';
import { boolToInt, nowIso } from '../utils';
import { fetchStockDataBatch } from '../engine';

type ToolCall = {
  id: string;
  name: string;
  arguments?: any;
};

type ToolResult = {
  id: string;
  name: string;
  ok: boolean;
  result?: any;
  error?: string;
};

// -----------------------------
// Tool args schemas
// -----------------------------

function getAgentsBaseUrl(): string {
  const raw = String(process.env.AGENTS_BASE_URL || 'http://127.0.0.1:8008').trim();
  return raw.replace(/\/$/, '');
}

// 工具接口类型
const ListStrategiesArgsSchema = z.object({
  name: z.string().optional(),
  enabledOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

// 工具接口类型
const CreateStrategyArgsSchema = z.object({
  name: z.string().min(1),
  symbols: z.union([z.string().min(1), z.array(z.string().min(1))]),

  enabled: z.boolean().optional().default(true),
  marketTimeOnly: z.boolean().optional().default(true),

  alertMode: z.enum(['percent', 'target']).optional().default('percent'),
  priceAlertPercent: z.number().min(0.1).optional().default(2),
  targetPriceUp: z.number().positive().optional(),
  targetPriceDown: z.number().positive().optional(),

  intervalMinutes: z.number().int().min(1).optional().default(1),
  cooldownMinutes: z.number().int().min(1).optional().default(60),

  subscriptionIds: z.array(z.string()).optional().default([]),

  enableMacdGoldenCross: z.boolean().optional().default(true),
  enableRsiOversold: z.boolean().optional().default(true),
  enableRsiOverbought: z.boolean().optional().default(true),
  enableMovingAverages: z.boolean().optional().default(false),
  enablePatternSignal: z.boolean().optional().default(true),
});

const DeleteStrategyArgsSchema = z.object({
  strategyId: z.string().min(1).optional(),
  // 兜底：允许通过 symbols/name 辅助匹配，但推荐优先使用 strategyId
  symbols: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  name: z.string().optional(),
});

const QueryTriggersArgsSchema = z.object({
  dateRange: z.enum(['today', 'week', 'month']).optional().default('today'),
  symbols: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

const GetDiagnosticArgsSchema = z.object({
  symbol: z.string().min(1),
  timeRange: z.enum(['1d', '3d', '7d']).optional().default('1d'),
});

const UpdateSubscriptionArgsSchema = z.object({
  // NOTE: Python 工具规范 uses dingtalk/wechat/email
  type: z.enum(['dingtalk', 'wechat', 'email']),
  endpoint: z.string().min(1).optional(),
  secret: z.string().optional(),
  enabled: z.boolean().optional().default(true),
});

const GetStockInfoArgsSchema = z.object({
  symbols: z.union([z.string().min(1), z.array(z.string().min(1))]),
  fields: z.array(z.string()).optional(),
});

const GenerateReportArgsSchema = z.object({
  reportType: z.enum(['daily', 'weekly', 'monthly']),
  dateRange: z.string().optional(),
  format: z.enum(['text', 'json', 'html']).optional().default('text'),
});

function normalizeSymbols(input: string | string[]): string {
  const arr = Array.isArray(input) ? input : String(input).split(',');
  return arr
    .map((x) => String(x).trim())
    .filter(Boolean)
    .join(',');
}

function normalizeSymbolList(input: string | string[]): string[] {
  const arr = Array.isArray(input) ? input : String(input).split(',');
  const out = arr
    .map((x) => String(x).trim())
    .filter(Boolean)
    .map((x) => String(x).toLowerCase())
    .map((x) => x.replace('.', '').replace(' ', ''));
  // 过滤空与去重
  return Array.from(new Set(out)).filter(Boolean);
}

function normalizeSinaCodeForQuery(symbol: string): string {
  // trigger_logs 的 symbol 来自 fetchStockDataBatch 返回的 code，通常是大写 SH/SZ 前缀。
  const raw = String(symbol || '').trim().toLowerCase().replace('.', '').replace(' ', '');
  const m = raw.match(/^(sh|sz)(\d{6})$/i);
  if (m) return `${m[1].toUpperCase()}${m[2]}`;
  const m2 = raw.match(/^(\d{6})$/);
  if (m2) {
    const code = m2[1];
    if (code.startsWith('6')) return `SH${code}`;
    if (code.startsWith('0') || code.startsWith('3')) return `SZ${code}`;
  }
  // 保底：直接转大写
  return raw.toUpperCase();
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function calcDateRangeForReport(reportType: 'daily' | 'weekly' | 'monthly'): { startDate: string; endDate: string } {
  const today = new Date();
  if (reportType === 'daily') return { startDate: dateStr(today), endDate: dateStr(today) };
  if (reportType === 'weekly') {
    const d = new Date(today);
    d.setDate(d.getDate() - 6);
    return { startDate: dateStr(d), endDate: dateStr(today) };
  }
  const d = new Date(today);
  d.setDate(d.getDate() - 29);
  return { startDate: dateStr(d), endDate: dateStr(today) };
}

// 策略列表
async function toolListStrategies(user: AuthedUser, args: unknown): Promise<any> {
  const parsed = ListStrategiesArgsSchema.parse(args || {});
  const limit = parsed.limit ?? 20;
  const db = await getDb();

  // 更稳妥：非管理员只返回自己的策略，避免数据泄露
  const where: string[] = [];
  const params: any[] = [];
  if (user.role !== 'admin') {
    where.push('user_id = ?');
    params.push(user.userId);
  }
  if (parsed.name) {
    where.push('name LIKE ?');
    params.push(`%${parsed.name}%`);
  }
  if (parsed.enabledOnly) {
    where.push('enabled = 1');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const stmt = db.prepare(`SELECT * FROM strategies ${whereSql} ORDER BY updated_at DESC LIMIT ${limit}`);
  stmt.bind(params);
  const items: any[] = [];
  while (stmt.step()) {
    items.push(rowToStrategy(stmt.getAsObject()));
  }
  stmt.free();

  // 返回字段尽量精简，避免 prompt 过大
  return {
    count: items.length,
    items: items.map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      symbols: s.symbols,
      alertMode: s.alertMode,
      priceAlertPercent: s.priceAlertPercent,
      targetPriceUp: s.targetPriceUp,
      targetPriceDown: s.targetPriceDown,
      intervalMs: s.intervalMs,
      cooldownMinutes: s.cooldownMinutes,
    })),
  };
}

// 创建策略工具
async function toolCreateStrategy(user: AuthedUser, args: unknown): Promise<any> {
  const parsed = CreateStrategyArgsSchema.parse(args || {});
  const symbols = normalizeSymbols(parsed.symbols);
  if (!symbols) {
    throw new Error('symbols 不能为空，请提供如 sh600519,sz000001');
  }

  const id = crypto.randomUUID();
  const ts = nowIso();

  const alertMode = parsed.alertMode;
  const intervalMs = parsed.intervalMinutes * 60_000;

  // DB schema: price_alert_percent NOT NULL
  const priceAlertPercent = typeof parsed.priceAlertPercent === 'number' ? parsed.priceAlertPercent : 2;

  const db = await getDb();

  const subscriptionIdsJson = parsed.subscriptionIds && parsed.subscriptionIds.length > 0
    ? JSON.stringify(parsed.subscriptionIds)
    : null;

  db.run(
    `INSERT INTO strategies (
      id,user_id,name,enabled,symbols,market_time_only,alert_mode,target_price_up,target_price_down,interval_ms,cooldown_minutes,price_alert_percent,
      enable_macd_golden_cross,enable_rsi_oversold,enable_rsi_overbought,enable_moving_averages,enable_pattern_signal,
      subscription_ids_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      user.userId,
      parsed.name,
      boolToInt(parsed.enabled),
      symbols,
      boolToInt(parsed.marketTimeOnly !== false),
      alertMode,
      alertMode === 'target' ? (parsed.targetPriceUp ?? null) : null,
      alertMode === 'target' ? (parsed.targetPriceDown ?? null) : null,
      intervalMs,
      parsed.cooldownMinutes,
      priceAlertPercent,
      boolToInt(parsed.enableMacdGoldenCross),
      boolToInt(parsed.enableRsiOversold),
      boolToInt(parsed.enableRsiOverbought),
      boolToInt(parsed.enableMovingAverages),
      boolToInt(parsed.enablePatternSignal),
      subscriptionIdsJson,
      ts,
      ts,
    ],
  );

  persist();

  return {
    id,
    name: parsed.name,
    symbols,
    enabled: parsed.enabled,
    alertMode,
    intervalMs,
    cooldownMinutes: parsed.cooldownMinutes,
  };
}

// 删除策略工具
async function toolDeleteStrategy(user: AuthedUser, args: unknown): Promise<any> {
  const parsed = DeleteStrategyArgsSchema.parse(args || {});
  const db = await getDb();

  // 优先按 strategyId 精确删除
  if (parsed.strategyId) {
    const stmtOwner = db.prepare('SELECT * FROM strategies WHERE id = ?');
    stmtOwner.bind([parsed.strategyId]);
    const row = stmtOwner.step() ? stmtOwner.getAsObject() : null;
    stmtOwner.free();
    if (!row) {
      throw new Error('策略不存在');
    }
    const ownerId = (row as any).user_id ? String((row as any).user_id) : '';
    if (user.role !== 'admin' && ownerId !== user.userId) {
      throw new Error('无权限删除该策略');
    }
    const strategy = rowToStrategy(row);
    db.run('DELETE FROM strategies WHERE id = ?', [parsed.strategyId]);
    persist();
    return {
      id: strategy.id,
      name: strategy.name,
      symbols: strategy.symbols,
    };
  }

  // 安全护栏：缺少精确条件时拒绝删除，避免误删
  if (!parsed.symbols && !parsed.name) {
    throw new Error('删除策略需要 strategyId，或至少提供 symbols/name 以避免误删');
  }

  // 兜底：根据 symbols/name 做宽松匹配，最多删除一条，避免误删
  const where: string[] = [];
  const params: any[] = [];
  if (user.role !== 'admin') {
    where.push('user_id = ?');
    params.push(user.userId);
  }
  if (parsed.symbols) {
    const symbolsStr = Array.isArray(parsed.symbols)
      ? parsed.symbols.join(',')
      : String(parsed.symbols);
    where.push('symbols LIKE ?');
    params.push(`%${symbolsStr.split(',')[0].trim()}%`);
  }
  if (parsed.name) {
    where.push('name LIKE ?');
    params.push(`%${parsed.name}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const stmt = db.prepare(
    `SELECT * FROM strategies ${whereSql} ORDER BY updated_at DESC LIMIT 1`,
  );
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();

  if (!row) {
    throw new Error('未找到可删除的策略，请提供更准确的策略ID或名称');
  }

  const strategy = rowToStrategy(row);
  db.run('DELETE FROM strategies WHERE id = ?', [strategy.id]);
  persist();
  return {
    id: strategy.id,
    name: strategy.name,
    symbols: strategy.symbols,
  };
}

// 查询触发记录工具（简版统计）
async function toolQueryTriggers(user: AuthedUser, args: unknown): Promise<any> {
  const parsed = QueryTriggersArgsSchema.parse(args || {});
  const db = await getDb();

  const params: any[] = [];
  let whereSql = 'WHERE 1=1';

  // 仅按 userId 过滤触发日志（如果存在），避免跨用户泄露
  if (user.role !== 'admin') {
    whereSql += ' AND user_id = ?';
    params.push(user.userId);
  }

  // dateRange -> startDate/endDate（基于 created_at 日期前缀）
  const today = new Date();
  const toDateStr = (d: Date) => d.toISOString().slice(0, 10);
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (parsed.dateRange === 'today') {
    startDate = toDateStr(today);
    endDate = toDateStr(today);
  } else if (parsed.dateRange === 'week') {
    const d = new Date(today);
    d.setDate(d.getDate() - 6);
    startDate = toDateStr(d);
    endDate = toDateStr(today);
  } else if (parsed.dateRange === 'month') {
    const d = new Date(today);
    d.setDate(d.getDate() - 29);
    startDate = toDateStr(d);
    endDate = toDateStr(today);
  }
  if (startDate) {
    whereSql += ' AND substr(created_at,1,10) >= ?';
    params.push(startDate);
  }
  if (endDate) {
    whereSql += ' AND substr(created_at,1,10) <= ?';
    params.push(endDate);
  }

  // symbols 过滤（支持单个或多个，模糊匹配）
  if (parsed.symbols) {
    const syms = Array.isArray(parsed.symbols)
      ? parsed.symbols
      : String(parsed.symbols).split(',');
    const trimmed = syms
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (trimmed.length > 0) {
      whereSql += ` AND (${trimmed
        .map(() => 'symbol LIKE ?')
        .join(' OR ')})`;
      for (const s of trimmed) {
        params.push(`%${s}%`);
      }
    }
  }

  const limit = parsed.limit ?? 20;
  const stmt = db.prepare(
    `SELECT * FROM trigger_logs ${whereSql} ORDER BY created_at DESC LIMIT ?`,
  );
  stmt.bind([...params, limit]);

  const items: any[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as any;
    let snapshot: any = null;
    try {
      snapshot = JSON.parse(row.snapshot_json);
    } catch {
      snapshot = null;
    }
    items.push({
      id: row.id,
      createdAt: row.created_at,
      userId: row.user_id,
      strategyId: row.strategy_id,
      subscriptionId: row.subscription_id,
      symbol: row.symbol,
      stockName: row.stock_name || undefined,
      reason: row.reason,
      snapshot,
      sendStatus: row.send_status || undefined,
      sendError: row.send_error || undefined,
    });
  }
  stmt.free();

  return {
    count: items.length,
    triggers: items.map((t) => ({
      symbol: t.symbol,
      type: t.reason,
      time: t.createdAt,
    })),
  };
}

// 获取诊断信息工具
async function toolGetDiagnostic(user: AuthedUser, args: unknown): Promise<any> {
  const parsed = GetDiagnosticArgsSchema.parse(args || {});
  const db = await getDb();

  const symbol = normalizeSinaCodeForQuery(parsed.symbol);

  const now = new Date();
  let startDate = dateStr(now);
  if (parsed.timeRange === '3d') {
    const d = new Date(now);
    d.setDate(d.getDate() - 2);
    startDate = dateStr(d);
  } else if (parsed.timeRange === '7d') {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    startDate = dateStr(d);
  }
  const endDate = dateStr(now);

  const params: any[] = [];
  let whereSql = 'WHERE 1=1';
  whereSql += ' AND symbol = ?';
  params.push(symbol);

  if (user.role !== 'admin') {
    whereSql += ' AND user_id = ?';
    params.push(user.userId);
  }

  whereSql += ' AND substr(created_at,1,10) >= ? AND substr(created_at,1,10) <= ?';
  params.push(startDate, endDate);

  const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM trigger_logs ${whereSql}`);
  countStmt.bind(params);
  let total = 0;
  if (countStmt.step()) {
    const row = countStmt.getAsObject() as any;
    total = Number(row.cnt || 0);
  }
  countStmt.free();

  const listStmt = db.prepare(
    `SELECT * FROM trigger_logs ${whereSql} ORDER BY created_at DESC LIMIT 10`,
  );
  listStmt.bind(params);

  const rows: any[] = [];
  while (listStmt.step()) {
    rows.push(listStmt.getAsObject());
  }
  listStmt.free();

  const reasonCounts: Record<string, number> = {};
  for (const r of rows) {
    const reason = String(r.reason || '').trim();
    if (!reason) continue;
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  const sortedReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const latest = rows[0] || null;
  let latestSnapshot: any = null;
  try {
    latestSnapshot = latest ? JSON.parse(latest.snapshot_json) : null;
  } catch {
    latestSnapshot = null;
  }

  const latestStock = latestSnapshot?.stock;
  const latestIndicator = latestSnapshot?.indicator;

  const diagnosis: Record<string, any> = {
    dateRange: `${startDate}~${endDate}`,
    triggerCount: total,
    topReasons: sortedReasons,
  };

  if (latest && typeof latest.reason === 'string') {
    diagnosis.latest = {
      time: latest.created_at,
      reason: latest.reason,
      sendStatus: latest.send_status || undefined,
    };
  }

  if (latestStock) {
    diagnosis.latestStock = {
      price: latestStock.currentPrice,
      changePercent: latestStock.changePercent,
      changePrice: latestStock.changePrice,
    };
  }
  if (latestIndicator) {
    diagnosis.latestIndicator = {
      macdTrend: latestIndicator.macd?.trend,
      rsiStatus: latestIndicator.rsi?.status,
      movingAveragesTrend: latestIndicator.movingAverages?.trend,
    };
  }

  return { symbol, diagnosis };
}

// 更新订阅工具
async function toolUpdateSubscription(user: AuthedUser, args: unknown): Promise<any> {
  const parsed = UpdateSubscriptionArgsSchema.parse(args || {});
  const db = await getDb();

  if (parsed.type === 'email') {
    throw new Error('email 通知暂未实现');
  }

  const endpoint = parsed.endpoint ? String(parsed.endpoint).trim() : '';
  if (!endpoint) {
    throw new Error('endpoint 不能为空（webhook URL 或邮箱地址）');
  }

  const nodeType = parsed.type === 'dingtalk' ? 'dingtalk' : 'wecom_robot';

  // 尽量把 subscription 表的 name 简单可读
  const wantName = `${parsed.type} subscription`;
  const wantEnabled = boolToInt(Boolean(parsed.enabled));

  // 按 (user_id,type,webhook_url) 找已有记录；没有则创建
  const stmt = db.prepare(
    `SELECT * FROM subscriptions WHERE user_id = ? AND type = ? AND webhook_url = ? ORDER BY updated_at DESC LIMIT 1`,
  );
  stmt.bind([user.userId, nodeType, endpoint]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();

  const ts = nowIso();
  if (row) {
    db.run(
      `UPDATE subscriptions SET
        name=?, enabled=?, webhook_url=?, keyword=?, updated_at=?
       WHERE id=?`,
      [wantName, wantEnabled, endpoint, null, ts, row.id],
    );
    persist();
    return { type: parsed.type, status: parsed.enabled ? '启用' : '停用' };
  }

  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO subscriptions (
      id,user_id,name,type,enabled,webhook_url,keyword,
      wecom_app_corp_id,wecom_app_corp_secret,wecom_app_agent_id,wecom_app_to_user,wecom_app_to_party,wecom_app_to_tag,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      user.userId,
      wantName,
      nodeType,
      wantEnabled,
      endpoint,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      ts,
      ts,
    ],
  );
  persist();
  return { type: parsed.type, status: parsed.enabled ? '启用' : '停用' };
}

// 查询股票实时信息工具
async function toolGetStockInfo(user: AuthedUser, args: unknown): Promise<any> {
  const parsed = GetStockInfoArgsSchema.parse(args || {});
  // user 参数目前不用于行情查询鉴权；保留以便未来做配额/权限
  void user;

  const syms = normalizeSymbolList(parsed.symbols);
  if (!syms.length) {
    throw new Error('symbols 不能为空');
  }

  // Node 的引擎使用新浪接口，通常要求 sh/sz 前缀（小写更稳妥）
  const codes = syms.map((s) => {
    const raw = String(s).trim();
    const m = raw.match(/^(sh|sz)(\d{6})$/i);
    if (m) return `${m[1].toLowerCase()}${m[2]}`;
    const m2 = raw.match(/^(\d{6})$/);
    if (m2) {
      const code = m2[1];
      if (code.startsWith('6')) return `sh${code}`;
      if (code.startsWith('0') || code.startsWith('3')) return `sz${code}`;
    }
    return raw;
  });

  const stocks = await fetchStockDataBatch(codes);
  return {
    stocks: stocks.map((s: any) => ({
      symbol: String(s.code || '').toLowerCase(),
      price: s.currentPrice,
      change: s.changePrice,
      changePercent: s.changePercent,
    })),
  };
}

// 生成报告工具（简版统计）
async function toolGenerateReport(user: AuthedUser, args: unknown): Promise<any> {
  const parsed = GenerateReportArgsSchema.parse(args || {});
  void parsed.format; // 当前只返回结构化摘要，由 Python tools formatter 渲染

  const db = await getDb();

  const { startDate, endDate } = calcDateRangeForReport(parsed.reportType);

  // 策略数量（统计启用中的策略）
  let stratWhere = 'WHERE enabled = 1';
  const stratParams: any[] = [];
  if (user.role !== 'admin') {
    stratWhere += ' AND user_id = ?';
    stratParams.push(user.userId);
  }
  const stratStmt = db.prepare(`SELECT COUNT(*) as cnt FROM strategies ${stratWhere}`);
  stratStmt.bind(stratParams);
  let strategyCount = 0;
  if (stratStmt.step()) {
    const row = stratStmt.getAsObject() as any;
    strategyCount = Number(row.cnt || 0);
  }
  stratStmt.free();

  // 触发数量与热门 symbol
  let trigWhere = `WHERE substr(created_at,1,10) >= ? AND substr(created_at,1,10) <= ?`;
  const trigParams: any[] = [startDate, endDate];
  if (user.role !== 'admin') {
    trigWhere += ' AND user_id = ?';
    trigParams.push(user.userId);
  }

  const trigCountStmt = db.prepare(`SELECT COUNT(*) as cnt FROM trigger_logs ${trigWhere}`);
  trigCountStmt.bind(trigParams);
  let triggerCount = 0;
  if (trigCountStmt.step()) {
    const row = trigCountStmt.getAsObject() as any;
    triggerCount = Number(row.cnt || 0);
  }
  trigCountStmt.free();

  const topSymbolsStmt = db.prepare(
    `SELECT symbol, COUNT(*) as cnt FROM trigger_logs ${trigWhere} GROUP BY symbol ORDER BY cnt DESC LIMIT 5`,
  );
  topSymbolsStmt.bind(trigParams);
  const topSymbols: any[] = [];
  while (topSymbolsStmt.step()) {
    topSymbols.push(topSymbolsStmt.getAsObject());
  }
  topSymbolsStmt.free();

  return {
    reportType: parsed.reportType,
    summary: {
      reportWindow: `${startDate}~${endDate}`,
      strategyCount,
      triggerCount,
      topSymbols,
    },
  };
}

// 执行工具
async function executeToolCall(user: AuthedUser, call: ToolCall): Promise<ToolResult> {
  const id = String(call?.id || 't1');
  const name = String(call?.name || '');
  const args = call?.arguments;

  try {
    switch (name) {
      case 'list_strategies': {
        const result = await toolListStrategies(user, args);
        return { id, name, ok: true, result };
      }
      case 'create_strategy': {
        const result = await toolCreateStrategy(user, args);
        return { id, name, ok: true, result };
      }
      case 'delete_strategy': {
        const result = await toolDeleteStrategy(user, args);
        return { id, name, ok: true, result };
      }
      case 'query_triggers': {
        const result = await toolQueryTriggers(user, args);
        return { id, name, ok: true, result };
      }
      case 'get_diagnostic': {
        const result = await toolGetDiagnostic(user, args);
        return { id, name, ok: true, result };
      }
      case 'update_subscription': {
        const result = await toolUpdateSubscription(user, args);
        return { id, name, ok: true, result };
      }
      case 'get_stock_info': {
        const result = await toolGetStockInfo(user, args);
        return { id, name, ok: true, result };
      }
      case 'generate_report': {
        const result = await toolGenerateReport(user, args);
        return { id, name, ok: true, result };
      }
      default:
        return { id, name, ok: false, error: `未知工具: ${name}` };
    }
  } catch (e: any) {
    return { id, name, ok: false, error: e?.message || String(e) };
  }
}

export function registerAgentRoutes(app: Express): void {
  // Agent 网关：
  // - /api/agent/chat：由 Node 作为 tools 执行器，进行多轮编排
  // - /api/agent/health：探活

  app.post('/api/agent/chat', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ message: 'message 不能为空' });

    const baseUrl = getAgentsBaseUrl();

    const basePayload = {
      message,
      context: req.body?.context,
      user,
      auth: { authorization: String(req.headers.authorization || '') },
    };

    const maxSteps = 3;
    const toolResults: ToolResult[] = [];

    try {
      for (let step = 0; step < maxSteps; step++) {
        const r = await axios.post(
          `${baseUrl}/agent/chat`,
          {
            ...basePayload,
            toolResults,
          },
          { timeout: 20000 },
        );

        const data = r.data || {};
        const toolCalls: ToolCall[] = Array.isArray(data.toolCalls) ? data.toolCalls : [];

        if (toolCalls.length > 0) {
          const safeCalls = toolCalls.slice(0, 5);
          const results = await Promise.all(safeCalls.map((c) => executeToolCall(user, c)));
          toolResults.push(...results);
          continue;
        }

        // final
        return res.json({ ...data, meta: { ...(data.meta || {}), orchestrator: 'node', steps: step + 1 } });
      }

      return res.status(500).json({
        message: 'Agent 编排达到最大轮次，请缩小问题或分步操作。',
        toolResults,
      });
    } catch (e: any) {
      const status = Number(e?.response?.status || 503);
      const detail = e?.response?.data || null;
      const msg = e?.message || 'agents service unavailable';
      return res.status(status).json({ message: 'agents 服务不可用', error: msg, detail });
    }
  });

  app.get('/api/agent/health', async (_req: Request, res: Response) => {
    const baseUrl = getAgentsBaseUrl();
    try {
      const r = await axios.get(`${baseUrl}/health`, { timeout: 5000 });
      res.json({ ok: true, upstream: r.data });
    } catch (e: any) {
      res.status(503).json({ ok: false, message: 'agents 服务不可用', error: e?.message || String(e) });
    }
  });
}
