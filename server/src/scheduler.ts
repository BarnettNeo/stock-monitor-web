import crypto from 'node:crypto';

import { execute, query } from './db';
import { runStrategyOnce, type Strategy } from './engine';
import { notifyBySubscription, type Subscription as NotifySubscription } from './notify';
import { buildNotifyPayload } from './message-templates';
import { intToBool, nowIso } from './utils';
import { rowToSubscription } from './mappers';

type StrategyRow = any;

export type SchedulerHandle = {
  stop: () => void;
};

function buildMarkdownFromEvent(ev: any): { title: string; markdown: string } {
  return buildNotifyPayload(ev, 'dingtalk');
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
        const subIds = (strategy as any).subscriptionIds as string[] | undefined;
        const targets = subIds && subIds.length > 0 ? subIds.map((id) => subMap.get(id)).filter(Boolean) : [undefined];

        for (const sub of targets) {
          // 每个订阅都单独落一条 trigger_log，便于回看不同渠道的发送结果。
          const payload = sub ? buildNotifyPayload(ev, sub.type) : buildMarkdownFromEvent(ev);
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

  return {
    stop: () => clearInterval(timer),
  };
}
