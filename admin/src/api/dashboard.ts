import { api } from '../api';

export type ScreenKpis = {
  runningStrategies: number;
  todayTriggers: number;
  pushSuccessRate?: number;
  monitoredSymbols: number;
};

export type ScreenLatestTrigger = {
  id: string;
  createdAt: string;
  symbol: string;
  stockName?: string;
  reason: string;
};

export type ScreenTrendPoint = {
  time: string;
  count: number;
};

export type WatchItem = {
  code: string;
  name?: string;
  currentPrice?: number;
  changePercent?: number;
};

export type ScreenOverview = {
  serverTime?: string;
  serverTimeIso?: string;
  kpis: ScreenKpis;
  latestTriggers: ScreenLatestTrigger[];
  deltaTriggers?: ScreenLatestTrigger[];
  todayTrend: ScreenTrendPoint[];
  watchlist: WatchItem[];
  latestTriggerDetailId?: string;
  cursor?: {
    latestCreatedAt?: string | null;
    latestCreatedAtIso?: string | null;
  };
};

export async function getScreenOverview(params?: { since?: string | null }): Promise<ScreenOverview> {
  const res = await api.get('/dashboard/screen', {
    params: {
      since: params?.since || undefined,
    },
  });
  return res.data as ScreenOverview;
}
