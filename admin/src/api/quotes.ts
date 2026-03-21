import { api } from '../api';

export type KlineItem = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  percent?: number;
  turnover?: number;
  amplitude?: number;
  change?: number;
  preclose?: number;
};

export type KlineResponse = {
  serverTime?: string;
  symbol: string;
  scale: string;
  datalen: number;
  items: KlineItem[];
};

export async function getKlineSeries(params: {
  symbol: string;
  scale?: string;
  datalen?: number;
}): Promise<KlineResponse> {
  const res = await api.get('/quotes/kline', {
    params: {
      symbol: params.symbol,
      scale: params.scale,
      datalen: params.datalen,
    },
  });
  return res.data as KlineResponse;
}

