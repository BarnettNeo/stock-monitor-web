<template>
  <div class="screen min-h-screen text-slate-200 p-4 box-border">
    <div class="flex items-center justify-between p-3 px-4 border border-slate-400/20 rounded-lg bg-slate-900/60 backdrop-blur">
      <div class="text-xl font-extrabold tracking-wide">监控大盘</div>
      <div class="flex gap-2 items-center">
        <div class="text-slate-300 tabular-nums">{{ displayTime }}</div>
        <el-button size="small" @click="refreshNow" :loading="loading">刷新</el-button>
        <el-button size="small" :icon="Setting" circle @click="goToStrategies" title="配置中心" />
      </div>
    </div>

    <div v-if="currentUser && currentUser.role !== 'admin' && data?.kpis?.monitoredSymbols === 0" class="mt-3">
      <div class=" border border-slate-400/20 rounded-lg bg-slate-900/60 backdrop-blur">
        <div class="text-center p-6">
          <p class="text-lg mb-4">您当前还没有配置任何监控策略。</p>
          <el-button type="primary" @click="goToStrategies">前往配置</el-button>
        </div>
      </div>
    </div>

    <div v-else class="grid grid-cols-4 gap-3 mt-3 max-[1280px]:grid-cols-2">
      <div class="border border-slate-400/20 rounded-lg bg-slate-900/50 p-4">
        <div class="text-slate-400 text-xs">运行中策略</div>
        <div class="mt-2 text-2xl font-extrabold tabular-nums">{{ data?.kpis?.runningStrategies ?? '-' }}</div>
      </div>
      <div class="border border-slate-400/20 rounded-lg bg-slate-900/50 p-4">
        <div class="text-slate-400 text-xs">今日触发</div>
        <div class="mt-2 text-2xl font-extrabold tabular-nums">{{ data?.kpis?.todayTriggers ?? '-' }}</div>
      </div>
      <div class="border border-slate-400/20 rounded-lg bg-slate-900/50 p-4">
        <div class="text-slate-400 text-xs">推送成功</div>
        <div class="mt-2 text-2xl font-extrabold tabular-nums">
          <template v-if="typeof data?.kpis?.pushSuccessRate === 'number'">
            {{ Math.round((data!.kpis!.pushSuccessRate || 0) * 100) }}%
          </template>
          <template v-else>-</template>
        </div>
      </div>
      <div class="border border-slate-400/20 rounded-lg bg-slate-900/50 p-4">
        <div class="text-slate-400 text-xs">监控股票数</div>
        <div class="mt-2 text-2xl font-extrabold tabular-nums">{{ data?.kpis?.monitoredSymbols ?? '-' }}</div>
      </div>
    </div>

    <div class="grid grid-cols-[1.2fr_1fr] gap-3 mt-3 max-[1280px]:grid-cols-1">
      <div class="border border-slate-400/20 rounded-lg bg-slate-900/50 p-3">
        <div class="font-extrabold mb-2">实时触发动态</div>
        <div class="h-[260px] overflow-hidden" v-loading="loading && !data">
          <div v-if="!data?.latestTriggers?.length" class="text-slate-400 p-6">暂无数据</div>
          <div v-else ref="feedContainerEl" class="feed-container">
            <div ref="feedListEl" class="feed-list">
              <div
                v-for="item in feedItems"
                :key="item.id"
                class="grid grid-cols-[200px_1fr] gap-2 p-2 rounded cursor-pointer hover:bg-slate-400/10"
                @click="openTrigger(item.id)"
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
              <!-- 视觉副本，用于无缝滚动 -->
              <div
                v-for="item in feedItems"
                :key="item.id + '-clone'"
                class="grid grid-cols-[200px_1fr] gap-2 p-2 rounded cursor-pointer hover:bg-slate-400/10"
                @click="openTrigger(item.id)"
                aria-hidden="true"
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

      <div class="border border-slate-400/20 rounded-lg bg-slate-900/50 p-3">
        <div class="font-extrabold mb-2">今日触发趋势</div>
        <div ref="trendEl" class="h-[300px] w-full"></div>
      </div>
    </div>

    <div class="border border-slate-400/20 rounded-lg bg-slate-900/50 p-3 mt-3">
      <div class="font-extrabold mb-2">重点关注股票</div>
      <div v-loading="loading && !data">
        <div v-if="!data?.watchlist?.length" class="text-slate-400 p-6">暂无监控标的</div>
        <div v-else class="grid grid-cols-6 gap-2 max-[1280px]:grid-cols-3">
          <div v-for="s in data.watchlist" :key="s.code" class="border border-slate-400/20 rounded-lg p-3 bg-slate-950/30">
            <div class="font-extrabold truncate">{{ s.name || s.code }}</div>
            <div class="text-slate-400 text-xs mt-1">{{ s.code }}</div>
            <div class="flex justify-between items-baseline mt-2">
              <span class="text-lg font-extrabold tabular-nums">{{ formatPrice(s.currentPrice) }}</span>
              <span class="text-xs tabular-nums" :class="changeClass(s.changePercent)">
                {{ formatChange(s.changePercent) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="border border-slate-400/20 rounded-lg bg-slate-900/50 p-3 mt-3">
      <div class="font-extrabold mb-2">最近一次异动详情</div>
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
import type { ScreenOverview, ScreenLatestTrigger, ScreenTrendPoint, WatchItem, ScreenKpis } from '../api/dashboard';
import { getScreenOverview } from '../api/dashboard';
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

let trendChart: echarts.ECharts | null = null;
let miniChart: echarts.ECharts | null = null;

let timer: number | null = null;
let clockTimer: number | null = null;
let inflight = false;
let feedTimer: number | null = null;

const pendingFeedQueue = ref<ScreenLatestTrigger[]>([]);

function getToday(): string {
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

// 优先请求后端聚合接口；若接口不可用则用已有接口做前端聚合兜底。
async function fetchOverviewPreferAggregate(): Promise<ScreenOverview> {
  try {
    return await getScreenOverview({ since: since.value });
  } catch {
    return await fetchOverviewFallback();
  }
}

async function fetchOverviewFallback(): Promise<ScreenOverview> {
  // 兜底逻辑的统计会受 pageSize 影响（最多 100 条），仅用于接口异常时的降级展示。
  const today = getToday();

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
    latestTriggers,
    todayTrend,
    watchlist,
    latestTriggerDetailId: latestTriggers[0]?.id,
  };
}

function renderTrend(): void {
  // 趋势图只依赖 todayTrend 数据；刷新时重新 setOption 覆盖即可。
  if (!trendEl.value) return;
  if (!trendChart) trendChart = echarts.init(trendEl.value);

  const points = data.value?.todayTrend || [];
  const x = points.map((p) => p.time);
  const y = points.map((p) => p.count);

  trendChart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 40, right: 20, top: 0, bottom: 20 },
    xAxis: {
      type: 'category',
      data: x,
      axisLabel: { color: '#cbd5e1' },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#cbd5e1' },
      splitLine: { lineStyle: { color: '#1f2937' } },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    tooltip: { trigger: 'axis' },
    dataZoom: [
      {
        type: 'inside',
        start: 0,
        end: 100,
      },
    ],
    series: [
      {
        type: 'line',
        data: y,
        smooth: true,
        areaStyle: { opacity: 0.15 },
        lineStyle: { width: 2 },
        symbol: 'circle',
        symbolSize: 6,
      },
    ],
  });
}

function renderMiniKline(): void {
  // 迷你 K 线从 trigger-logs/:id 的 kline 字段渲染。
  if (!miniKlineEl.value) return;
  if (!miniChart) miniChart = echarts.init(miniKlineEl.value);

  const k = detail.value?.kline || [];
  const categoryData = k.map((x) => x.date.slice(11, 16)); // 只取 HH:mm
  const closeData = k.map((x) => x.close);

  miniChart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 40, right: 20, top: 30, bottom: 50 }, // 增大 bottom 为 dataZoom 留空间
    xAxis: {
      type: 'category',
      data: categoryData,
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
    dataZoom: [
      {
        type: 'inside',
        start: 0,
        end: 100,
      },
    ],
    series: [
      {
        name: '收盘价',
        type: 'line',
        data: closeData,
        itemStyle: { color: '#60a5fa' }, // 蓝色
      },
    ],
  });
}

async function loadDetail(id: string): Promise<void> {
  // 大屏只展示最近一次触发的简要信息；详情数据按需请求，避免聚合接口过大。
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
  // 刷新策略：
  // - 同时刻只允许一个请求在途，避免点击/定时触发叠加
  // - 页面不可见时暂停，减少无意义请求
  if (inflight) return;
  if (document.hidden) return;

  inflight = true;
  loading.value = true;
  try {
    const overview = await fetchOverviewPreferAggregate();
    data.value = overview;
    const cursorCreatedAt = overview.cursor?.latestCreatedAt;
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

    await nextTick();
    renderTrend();
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

function goToLogs(): void {
  router.push('/trigger-logs');
}

function goToStrategies(): void {
  router.push('/strategies');
}

function openTrigger(id: string): void {
  router.push(`/trigger-logs/${id}`);
}

function onResize(): void {
  trendChart?.resize();
  miniChart?.resize();
}

function onVisibility(): void {
  if (!document.hidden) {
    refresh();
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
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
  if (clockTimer) window.clearInterval(clockTimer);
  if (feedTimer) window.clearInterval(feedTimer);
  window.removeEventListener('resize', onResize);
  document.removeEventListener('visibilitychange', onVisibility);
  trendChart?.dispose();
  trendChart = null;
  miniChart?.dispose();
  miniChart = null;
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
</script>

<style scoped>
.screen {
  background: radial-gradient(1200px 700px at 20% 10%, rgba(56, 189, 248, 0.08), transparent),
    radial-gradient(1000px 600px at 80% 20%, rgba(34, 197, 94, 0.06), transparent),
    linear-gradient(180deg, #0b1220, #020617);
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
.toLogsBtn{
  position: relative;
  margin: 12px auto 0;
  display: block;
}
</style>
