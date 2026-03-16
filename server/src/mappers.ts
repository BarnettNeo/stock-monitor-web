import { intToBool } from './utils';

export function rowToStrategy(row: any): any {
  const subscriptionIds: string[] = row.subscription_ids_json
    ? JSON.parse(String(row.subscription_ids_json))
    : [];

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    enabled: intToBool(row.enabled),
    symbols: row.symbols,
    marketTimeOnly: row.market_time_only === undefined || row.market_time_only === null ? true : intToBool(row.market_time_only),
    subscriptionIds,
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
    enablePatternSignal: intToBool(row.enable_pattern_signal),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToSubscription(row: any): any {
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
