import { api } from '../api';

export type KlineCloseItem = {
  time: string;
  close: number;
};

export type KlineCloseResponse = {
  serverTime?: string;
  symbol: string;
  scale: string;
  datalen: number;
  items: KlineCloseItem[];
};

export async function getKlineCloseSeries(params: {
  symbol: string;
  scale?: string;
  datalen?: number;
}): Promise<KlineCloseResponse> {
  const res = await api.get('/quotes/kline', {
    params: {
      symbol: params.symbol,
      scale: params.scale,
      datalen: params.datalen,
    },
  });
  return res.data as KlineCloseResponse;
}

