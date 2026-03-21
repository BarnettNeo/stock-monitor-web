<template>
  <div class="screen min-h-screen text-slate-200 p-4 box-border">
    <div class="panel panel--strong flex items-center justify-between p-3 px-4">
      <div class="text-xl font-extrabold tracking-wide">监控大盘</div>
      <div class="flex gap-2 items-center">
        <div class="text-slate-300 tabular-nums">{{ displayTime }}</div>
        <el-button size="small" @click="refreshNow" :loading="loading">刷新</el-button>
        <el-button size="small" :icon="Setting" circle @click="goToStrategies" title="配置中心" />
      </div>
    </div>

    <div v-if="currentUser && currentUser.role !== 'admin' && data?.kpis?.monitoredSymbols === 0" class="mt-3">
      <div class="panel panel--strong">
        <div class="text-center p-6">
          <p class="text-lg mb-4">您当前还没有配置任何监控策略。</p>
          <el-button type="primary" @click="goToStrategies">前往配置</el-button>
        </div>
      </div>
    </div>

    <!-- 监控大盘卡片 -->
    <div v-else class="grid grid-cols-4 gap-3 mt-3 max-[1280px]:grid-cols-2">
      <div v-for="c in kpiCards" :key="c.label" class="panel p-4">
        <div class="kpi-label">{{ c.label }}</div>
        <div class="kpi-value tabular-nums">{{ c.value }}</div>
      </div>
    </div>

    <!-- 实时触发动态卡片 -->
    <div class="grid grid-cols-[1fr_1fr] gap-3 mt-3 max-[1280px]:grid-cols-1">
      <div class="panel p-3">
        <div class="panel-title">实时触发动态</div>
        <div class="h-[260px] overflow-hidden" v-loading="loading && !data">
          <div v-if="!data?.latestTriggers?.length" class="text-slate-400 p-6">暂无数据</div>
          <div v-else ref="feedContainerEl" class="feed-container">
            <div ref="feedListEl" class="feed-list">
              <div
                v-for="(item, idx) in feedLoopItems"
                :key="item.id + '-' + idx"
                class="grid grid-cols-[200px_1fr] gap-2 p-2 rounded cursor-pointer hover:bg-slate-400/10"
                @click="openTrigger(item.id)"
                :aria-hidden="idx >= feedItems.length ? 'true' : undefined"
              >
                <div class="text-slate-400 tabular-nums">{{ item.createdAt }}</div>
                <div>
                  <div class="flex gap-2 items-baseline">
                    <span class="font-extrabold">{{ item.stockName || item.symbol }}</span>
                    <span class="text-slate-200">{{ item.reason }}</span>
                  </div>
                  <div class="text-slate-500 text-xs">{{ item.symbol }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- 居中按钮 -->
        <el-button class="toLogsBtn" size="small" type="primary" @click="goToLogs">查看全部触发记录</el-button>
      </div>

      <div class="panel p-3">
        <div class="panel-title">今日触发趋势</div>
        <div ref="trendEl" class="h-[300px] w-full"></div>
      </div>
    </div>

    <div class="grid grid-cols-[1fr_1fr] gap-3 mt-3 max-[1280px]:grid-cols-1">
      <!-- 重点关注股票卡片 -->
      <div class="panel p-3 mt-3">
        <div class="flex items-center gap-3 mb-2">
          <div class="panel-title mb-0">重点关注股票K线</div>
          <el-select
            v-model="focusSymbol"
            placeholder="请选择股票"
            filterable
            class="!w-[220px]"
            :disabled="focusSymbolOptions.length === 0"
          >
            <el-option v-for="s in focusSymbolOptions" :key="s.code" :label="s.name" :value="s.code" />
          </el-select>
        </div>
        <div v-loading="focusLoading || (loading && !data)">
          <div v-if="focusSymbolOptions.length === 0" class="text-slate-400 p-6">暂无监控标的</div>
          <div v-else ref="focusChartEl" class="h-[260px] w-full"></div>
        </div>
      </div>

      <!-- 热门股票分析 -->
      <div class="panel p-3 mt-3">
        <div class="panel-title">热门股票分析</div>
        <div class="h-[220px]"></div>
      </div>
  </div>
    <!-- 近3日上涨股票卡片 -->
    <div class="grid grid-cols-2 gap-3 mt-3 max-[1280px]:grid-cols-1">
      <div v-for="block in hotBlocks" :key="block.key" class="panel p-3">
        <div class="flex items-baseline justify-between mb-2">
          <div class="panel-title mb-0">{{ block.title }}</div>
          <div class="text-slate-500 text-xs tabular-nums">{{ hotServerTime || '' }}</div>
        </div>
        <div v-loading="hotLoading">
          <div v-if="block.items.length === 0" class="text-slate-400 p-6">暂无数据</div>
          <div v-else class="grid grid-cols-2 gap-2 max-[1280px]:grid-cols-1">
            <div v-for="s in block.items" :key="s.code" class="panel-item p-3">
              <div class="flex justify-between items-baseline gap-2">
                <div class="font-extrabold truncate">{{ s.name || s.code }}</div>
                <el-button size="small" type="primary" plain @click="goToStrategiesCreate(s.code)">一键添加</el-button>
              </div>
              <div class="flex justify-between items-baseline mt-2">
                <div class="text-slate-400 text-xs mt-1">{{ s.code }}</div>
                <div class="text-xs tabular-nums" :class="changeClass(s.returnNd)">{{ formatChange(s.returnNd) }}</div>
              </div>
              <div class="flex justify-between items-baseline mt-2">
                <span class="tabular-nums">{{ formatPrice(s.currentPrice) }}</span>
                <span class="text-xs tabular-nums" :class="changeClass(s.changePercent)">
                  {{ formatChange(s.changePercent) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 最近一次异动详情卡片 -->
    <div class="panel p-3 mt-3">
      <div class="panel-title">最近一次异动详情</div>
      <div v-loading="detailLoading">
        <div v-if="!detail" class="text-slate-400 p-6">暂无触发详情</div>
        <div v-else class="grid grid-cols-[420px_1fr] gap-3 items-stretch max-[1280px]:grid-cols-1">
          <div>
            <div ref="miniKlineEl" class="h-[240px] w-full"></div>
          </div>
          <div>
            <div class="font-extrabold text-base">{{ detail.stockName || detail.symbol }} - {{ detail.reason }}</div>
            <div class="text-slate-200 mt-2">触发时间：{{ detail.createdAt }}</div>
            <div class="text-slate-200 mt-2">触发价格：{{ formatPrice(detail.snapshot?.stock?.currentPrice) }}</div>
            <div class="text-slate-200 mt-2">原因：待ai分析生成</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import * as echarts from 'echarts';
import { ElMessage } from 'element-plus';

import { api } from '../api';
import type { HotMoverItem, ScreenOverview, ScreenLatestTrigger, ScreenTrendPoint, WatchItem, ScreenKpis } from '../api/dashboard';
import { getHotMovers, getScreenOverview } from '../api/dashboard';
import type { KlineItem } from '../api/quotes';
import { getKlineSeries } from '../api/quotes';
import { ensureChart, setLineChart } from '../utils/charts';
import { Setting } from '@element-plus/icons-vue';

type TriggerDetail = {
  id: string;
  createdAt: string;
  symbol: string;
  stockName?: string;
  reason: string;
  snapshot: any;
  kline?: Array<{
    date: string;
    open: number;
    close: number;
    high: number;
    low: number;
    volume: number;
  }>;
};

const router = useRouter();

const currentUser = ref<{ role: string } | null>(null);

const now = ref(new Date());
const nowText = computed(() => now.value.toLocaleString('zh-CN'));
const displayTime = computed(() => data.value?.serverTime || nowText.value);

const loading = ref(false);
const data = ref<ScreenOverview | null>(null);
const feedItems = ref<ScreenLatestTrigger[]>([]);
const feedContainerEl = ref<HTMLDivElement | null>(null);
const feedListEl = ref<HTMLDivElement | null>(null);
const since = ref<string | null>(null);

const detailLoading = ref(false);
const detail = ref<TriggerDetail | null>(null);

const trendEl = ref<HTMLDivElement | null>(null);
const miniKlineEl = ref<HTMLDivElement | null>(null);
const focusChartEl = ref<HTMLDivElement | null>(null);

let trendChart: echarts.ECharts | null = null;
let miniChart: echarts.ECharts | null = null;
let focusChart: echarts.ECharts | null = null;

let timer: number | null = null;
let clockTimer: number | null = null;
let inflight = false;
let feedTimer: number | null = null;
let hotTimer: number | null = null;
let hotInflight = false;

const pendingFeedQueue = ref<ScreenLatestTrigger[]>([]);

const focusSymbol = ref<string>('');
const focusLoading = ref(false);
const focusSeries = ref<KlineItem[]>([]);

const focusSymbolOptions = computed(() => {
  const fromWatch = Array.isArray(data.value?.watchlist) ? data.value!.watchlist : [];
  return fromWatch;
});

const focusStock = computed(() => {
  return focusSymbolOptions.value.find((s) => s.code === focusSymbol.value);
});

const hotLoading = ref(false);
const hotServerTime = ref<string>('');
const hotGainers = ref<HotMoverItem[]>([]);
const hotLosers = ref<HotMoverItem[]>([]);

const kpiCards = computed(() => {
  const kpis = data.value?.kpis;
  const push =
    typeof kpis?.pushSuccessRate === 'number'
      ? `${Math.round((kpis.pushSuccessRate || 0) * 100)}%`
      : '-';
  return [
    { label: '运行中策略', value: kpis?.runningStrategies ?? '-' },
    { label: '今日触发', value: kpis?.todayTriggers ?? '-' },
    { label: '推送成功', value: push },
    { label: '监控股票数', value: kpis?.monitoredSymbols ?? '-' },
  ];
});

const feedLoopItems = computed(() => {
  const base = feedItems.value || [];
  if (base.length === 0) return [];
  return base.concat(base);
});

const hotBlocks = computed(() => [
  { key: 'gainers', title: '近3日上涨股票', items: hotGainers.value },
  { key: 'losers', title: '近3日下跌股票', items: hotLosers.value },
]);

function getLocalDateStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatPrice(v: any): string {
  const n = Number(v);
  if (!isFinite(n)) return '--';
  return n.toFixed(2);
}

function formatChange(v: any): string {
  const n = Number(v);
  if (!isFinite(n)) return '--';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(2)}%`;
}

function changeClass(v: any): string {
  const n = Number(v);
  if (!isFinite(n)) return '';
  if (n > 0) return 'text-red-500';
  if (n < 0) return 'text-green-500';
  return '';
}

// 大屏核心数据源：
// - 优先请求后端聚合接口（/dashboard/screen）
// - 后端不可用时降级为“前端聚合”（统计口径会受 pageSize 影响）
async function fetchOverviewPreferAggregate(): Promise<ScreenOverview> {
  try {
    return await getScreenOverview({ since: since.value });
  } catch {
    return await fetchOverviewFallback();
  }
}

async function fetchOverviewFallback(): Promise<ScreenOverview> {
  // 兜底逻辑的统计会受 pageSize 影响（最多 100 条），仅用于接口异常时的降级展示。
  const today = getLocalDateStr();

  const [strategiesRes, logsRes] = await Promise.all([
    api.get('/strategies'),
    api.get('/trigger-logs', {
      params: { page: 1, pageSize: 100, startDate: today, endDate: today },
    }),
  ]);

  const strategies: any[] = Array.isArray(strategiesRes.data?.items) ? strategiesRes.data.items : [];
  const enabled = strategies.filter((s) => Boolean(s.enabled));
  const symbols = new Set<string>();
  for (const s of enabled) {
    const raw = typeof s.symbols === 'string' ? s.symbols : '';
    raw.split(',').map((x: string) => x.trim()).filter(Boolean).forEach((x: string) => symbols.add(x));
  }

  const logs: any[] = Array.isArray(logsRes.data?.items) ? logsRes.data.items : [];

  const latestTriggers: ScreenLatestTrigger[] = logs.slice(0, 20).map((it: any) => ({
    id: String(it.id),
    createdAt: String(it.createdAt || it.created_at || ''),
    symbol: String(it.symbol || ''),
    stockName: it.stockName || undefined,
    reason: String(it.reason || ''),
  }));

  const trendMap = new Map<string, number>();
  for (const it of logs) {
    const t = String(it.createdAt || it.created_at || '');
    const hour = t.length >= 13 ? t.slice(11, 13) : '00';
    const key = `${hour}:00`;
    trendMap.set(key, (trendMap.get(key) || 0) + 1);
  }
  const todayTrend: ScreenTrendPoint[] = Array.from(trendMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([time, count]) => ({ time, count }));

  const kpis: ScreenKpis = {
    runningStrategies: enabled.length,
    todayTriggers: logs.length,
    monitoredSymbols: symbols.size,
  };

  const watchlist: WatchItem[] = Array.from(symbols).slice(0, 12).map((code) => ({ code }));

  return {
    kpis,
    focusSymbols: Array.from(symbols),
    latestTriggers,
    todayTrend,
    watchlist,
    latestTriggerDetailId: latestTriggers[0]?.id,
  };
}

function renderTrend(): void {
  // 今日触发趋势：只依赖 data.todayTrend，数据变更后重绘即可。
  const chart = ensureChart(trendEl.value, trendChart);
  if (!chart) return;
  trendChart = chart;

  const points = data.value?.todayTrend || [];
  setLineChart(chart, {
    x: points.map((p) => p.time),
    series: [
      { name: '触发次数', y: points.map((p) => p.count), color: '#60a5fa' },
    ],
    grid: { left: 40, right: 20, top: 20, bottom: 20 },
  });
}

function renderMiniKline(): void {
  // 最近一次触发详情：从 trigger-logs/:id 返回的 kline 绘制“收盘价折线”，轻量展示走势。
  const chart = ensureChart(miniKlineEl.value, miniChart);
  if (!chart) return;
  miniChart = chart;
  const k = detail.value?.kline || [];
  chart.setOption(
    {
      backgroundColor: 'transparent',
      grid: { left: 40, right: 20, top: 30, bottom: 50 },
      xAxis: {
        type: 'category',
        data: k.map((x) => x.date.slice(11, 16)),
        axisLabel: { color: '#94a3b8', show: true },
        axisLine: { lineStyle: { color: '#334155' } },
      },
      yAxis: {
        scale: true,
        axisLabel: { color: '#94a3b8' },
        splitLine: { lineStyle: { color: '#1f2937' } },
        axisLine: { lineStyle: { color: '#334155' } },
      },
      tooltip: { trigger: 'axis' },
      dataZoom: [{ type: 'inside', start: 0, end: 100 }],
      series: [
        {
          name: '收盘价',
          type: 'line',
          data: k.map((x) => x.close),
          lineStyle: { width: 2, color: '#60a5fa' },
          itemStyle: { color: '#60a5fa' },
          symbol: 'circle',
          symbolSize: 5,
          smooth: true,
        },
      ],
    },
    { notMerge: true },
  );
}

function renderFocusChart(): void {
  const chart = ensureChart(focusChartEl.value, focusChart);
  if (!chart) return;
  focusChart = chart;
  const items = focusSeries.value || [];
  const x = items.map((p) => {
    const t = String(p.time || '');
    if (t.includes(' ')) return t.split(' ')[0];
    return t;
  });

  const tooltip: echarts.TooltipComponentOption = {
    trigger: 'axis',
    formatter: (params: any) => {
      const dataIndex = params[0].dataIndex;
      const data = items[dataIndex];
      if (!data) return '';

      const stockName = focusStock.value?.name || '';
      const date = new Date(data.time).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
      const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][new Date(data.time).getDay()];

      const formatPrice = (label: string, price: number, percent: number) => {
        const color = percent > 0 ? '#ef4444' : percent < 0 ? '#22c55e' : '#9ca3af';
        const sign = percent > 0 ? '+' : '';
        return `${label}: <span style="color: ${color}">${price.toFixed(2)} (${sign}${percent.toFixed(2)}%)</span>`;
      };

      const openPercent = data.preclose ? ((data.open - data.preclose) / data.preclose) * 100 : 0;
      const highPercent = data.preclose ? ((data.high - data.preclose) / data.preclose) * 100 : 0;
      const lowPercent = data.preclose ? ((data.low - data.preclose) / data.preclose) * 100 : 0;
      const closePercent = data.percent || 0;

      let html = `<div class="text-left">`;
      html += `<b>${stockName}</b><br/>`;
      html += `${date} 周${dayOfWeek}<br/>`;
      html += `--------------------<br/>`;
      html += `${formatPrice('开盘', data.open, openPercent)}<br/>`;
      html += `${formatPrice('最高', data.high, highPercent)}<br/>`;
      html += `${formatPrice('最低', data.low, lowPercent)}<br/>`;
      html += `${formatPrice('收盘', data.close, closePercent)}<br/>`;
      html += `涨跌: <span style="color: ${data.change && data.change > 0 ? '#ef4444' : (data.change && data.change < 0 ? '#22c55e' : '#9ca3af')}">${typeof data.change === 'number' ? data.change.toFixed(2) : '--'} (${typeof closePercent === 'number' ? closePercent.toFixed(2) : '--'}%)</span><br/>`;
      html += `成交: ${(data.volume / 10000).toFixed(2)}万手<br/>`;
      html += `换手: ${typeof data.turnover === 'number' ? data.turnover.toFixed(2) + '%' : '--'}<br/>`;
      html += `振幅: ${typeof data.amplitude === 'number' ? data.amplitude.toFixed(2) + '%' : '--'}<br/>`;
      html += `</div>`;
      return html;
    },
  };

  const legend = {
    data: ['收盘', '开盘', '最高', '最低'],
    textStyle: {
      color: '#ccc',
    },
    top: 0,
    right: 20,
  };

  setLineChart(chart, {
    x,
    series: [
      { name: '收盘', y: items.map((p) => p.close), color: '#60a5fa' },
      { name: '开盘', y: items.map((p) => p.open), color: '#facc15' },
      { name: '最高', y: items.map((p) => p.high), color: '#f87171' },
      { name: '最低', y: items.map((p) => p.low), color: '#4ade80' },
    ],
    grid: { left: 40, right: 20, top: 40, bottom: 30 },
    tooltip,
    legend,
  });
}

async function loadFocusSeries(symbol: string): Promise<void> {
  // 拉取“重点关注股票”的 K 线序列，并刷新图表。
  focusLoading.value = true;
  try {
    const res = await getKlineSeries({ symbol, scale: '240', datalen: 60 });
    focusSeries.value = Array.isArray(res.items) ? res.items : [];
    await nextTick();
    renderFocusChart();
  } catch (e: any) {
    focusSeries.value = [];
    ElMessage.error(e?.response?.data?.message || e?.message || '加载K线失败');
  } finally {
    focusLoading.value = false;
  }
}

async function loadDetail(id: string): Promise<void> {
  // 大屏只展示最近一次触发的简要信息；详情数据按需请求，避免聚合接口返回过大。
  detailLoading.value = true;
  try {
    const res = await api.get(`/trigger-logs/${id}`);
    detail.value = res.data?.item || null;
    await nextTick();
    renderMiniKline();
  } catch (e: any) {
    detail.value = null;
    ElMessage.error(e?.response?.data?.message || e?.message || '加载触发详情失败');
  } finally {
    detailLoading.value = false;
  }
}

async function refresh(): Promise<void> {
  // 大屏刷新（核心链路）：
  // 1) 拉取后端聚合数据（或前端兜底聚合）
  // 2) 处理最新触发增量（deltaTriggers -> pendingFeedQueue -> 滚动列表）
  // 3) 按需加载“最近一次触发详情”（用于右下角迷你图）
  if (inflight) return;
  if (document.hidden) return;

  inflight = true;
  loading.value = true;
  try {
    const overview = await fetchOverviewPreferAggregate();
    data.value = overview;
    const cursorCreatedAt = overview.cursor?.latestCreatedAtIso || overview.cursor?.latestCreatedAt;
    if (cursorCreatedAt) {
      since.value = cursorCreatedAt;
    }

    const delta = Array.isArray(overview.deltaTriggers) ? overview.deltaTriggers : [];
    const initial = feedItems.value.length === 0;
    if (initial) {
      feedItems.value = Array.isArray(overview.latestTriggers) ? overview.latestTriggers.slice(0, 20) : [];
    } else if (delta.length > 0) {
      enqueueDelta(delta);
    } else {
      const incoming = Array.isArray(overview.latestTriggers) ? overview.latestTriggers : [];
      const exist = new Set(feedItems.value.map((x) => x.id));
      const diff = incoming.filter((x) => !exist.has(x.id));
      if (diff.length > 0) enqueueDelta(diff);
    }

    if (overview.latestTriggerDetailId) {
      if (!detail.value || detail.value.id !== overview.latestTriggerDetailId) {
        await loadDetail(overview.latestTriggerDetailId);
      }
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '刷新失败');
  } finally {
    loading.value = false;
    inflight = false;
  }
}

function enqueueDelta(items: ScreenLatestTrigger[]): void {
  // 将新增触发事件入队，由定时器节奏化插入，避免列表瞬间跳动。
  const sorted = [...items].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const exist = new Set(feedItems.value.map((x) => x.id));
  const queued = new Set(pendingFeedQueue.value.map((x) => x.id));
  for (const it of sorted) {
    if (exist.has(it.id) || queued.has(it.id)) continue;
    pendingFeedQueue.value.push(it);
  }
  startFeedTicker();
}

function startFeedTicker(): void {
  // 按固定节奏把队列里的新触发插到顶部，制造“实时滚动”的观感。
  if (feedTimer) return;
  feedTimer = window.setInterval(() => {
    const next = pendingFeedQueue.value.shift();
    if (!next) {
      if (feedTimer) window.clearInterval(feedTimer);
      feedTimer = null;
      return;
    }
    const exist = new Set(feedItems.value.map((x) => x.id));
    if (exist.has(next.id)) return;
    feedItems.value = [next, ...feedItems.value].slice(0, 20);
    nextTick().then(() => {
      const el = feedListEl.value;
      if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, 320);
}

async function refreshNow(): Promise<void> {
  await refresh();
}

async function refreshHotMovers(): Promise<void> {
  // 热门涨跌榜：独立于主刷新，刷新频率更低。
  if (hotInflight) return;
  if (document.hidden) return;

  hotInflight = true;
  hotLoading.value = true;
  try {
    const res = await getHotMovers({ windowDays: 3, limit: 10 });
    hotServerTime.value = res.serverTime || '';
    hotGainers.value = Array.isArray(res.gainers) ? res.gainers : [];
    hotLosers.value = Array.isArray(res.losers) ? res.losers : [];
  } catch (e: any) {
    hotGainers.value = [];
    hotLosers.value = [];
    ElMessage.error(e?.response?.data?.message || e?.message || '加载热门榜单失败');
  } finally {
    hotLoading.value = false;
    hotInflight = false;
  }
}

function goToLogs(): void {
  router.push('/trigger-logs');
}

function goToStrategies(): void {
  router.push('/strategies');
}

function goToStrategiesCreate(code: string): void {
  router.push({ path: '/strategies', query: { create: '1', code } });
}

function openTrigger(id: string): void {
  router.push(`/trigger-logs/${id}`);
}

function onResize(): void {
  trendChart?.resize();
  miniChart?.resize();
  focusChart?.resize();
}

function onVisibility(): void {
  if (!document.hidden) {
    refresh();
    refreshHotMovers();
  }
}

async function getUserInfo() {
  try {
    const res = await api.get('/auth/me');
    currentUser.value = res.data?.user || null;
  } catch {
    currentUser.value = null;
  }
}

onMounted(() => {
  // 页面启动：
  // - 1s 更新时钟
  // - 8s 刷新主大屏数据
  // - 10min 刷新热门涨跌榜
  getUserInfo();
  clockTimer = window.setInterval(() => {
    now.value = new Date();
  }, 1000);

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);

  refresh();
  timer = window.setInterval(() => {
    refresh();
  }, 8000);

  refreshHotMovers();
  hotTimer = window.setInterval(() => {
    refreshHotMovers();
  }, 10 * 60 * 1000);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
  if (clockTimer) window.clearInterval(clockTimer);
  if (feedTimer) window.clearInterval(feedTimer);
  if (hotTimer) window.clearInterval(hotTimer);
  window.removeEventListener('resize', onResize);
  document.removeEventListener('visibilitychange', onVisibility);
  trendChart?.dispose();
  trendChart = null;
  miniChart?.dispose();
  miniChart = null;
  focusChart?.dispose();
  focusChart = null;
});

watch(feedItems, (newItems) => {
  if (feedListEl.value) {
    // 根据列表项的数量动态计算动画时长，假设每个 item 高度约 52px，滚动速度约 52px/s
    const duration = newItems.length * 1.5; // 每个 item 滚动 1.5s
    feedListEl.value.style.animationDuration = `${duration}s`;
  }
}, { deep: true, flush: 'post' });

watch(
  () => data.value?.todayTrend,
  () => {
    nextTick().then(renderTrend);
  },
);

watch(focusSymbolOptions, (opts) => {
  if (!opts.length) {
    focusSymbol.value = '';
    focusSeries.value = [];
    return;
  }
  if (!focusSymbol.value || !opts.some((x) => x.code === focusSymbol.value)) {
    focusSymbol.value = opts[0].code;
  }
}, { immediate: true });

watch(focusSymbol, (sym) => {
  console.log('focusSymbol', sym);
  if (!sym) return;
  loadFocusSeries(sym);
});
</script>

<style scoped>
.screen {
  background: radial-gradient(1200px 700px at 20% 10%, rgba(56, 189, 248, 0.08), transparent),
    radial-gradient(1000px 600px at 80% 20%, rgba(34, 197, 94, 0.06), transparent),
    linear-gradient(180deg, #0b1220, #020617);
}

.panel {
  @apply border border-slate-400/20 rounded-lg bg-slate-900/50;
}

.panel--strong {
  @apply bg-slate-900/60 backdrop-blur;
}

.panel-title {
  @apply font-extrabold mb-2;
}

.kpi-label {
  @apply text-slate-400 text-xs;
}

.kpi-value {
  @apply mt-2 text-2xl font-extrabold;
}

.panel-item {
  @apply border border-slate-400/20 rounded-lg bg-slate-950/30;
}

.feed-enter-active,
.feed-leave-active {
  transition: all 0.32s ease;
}

.feed-enter-from {
  opacity: 0;
  transform: translateY(-10px);
}

.feed-enter-to {
  opacity: 1;
  transform: translateY(0);
  position: relative;
  margin: 0 auto;
}

.feed-move {
  transition: transform 0.32s ease;
}

@keyframes scroll-up {
  from {
    transform: translateY(0);
  }
  to {
    transform: translateY(-50%);
  }
}

.feed-container:hover .feed-list {
  animation-play-state: paused;
}

.feed-list {
  animation: scroll-up linear infinite;
}
.toLogsBtn {
  position: relative;
  margin: 12px auto 0;
  display: block;
}
</style>
