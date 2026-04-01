<template>
  <div class="">
    <el-button class="mb-4" @click="backToList">&lt; 返回触发记录列表</el-button>

    <div v-if="loading" class="text-center py-10">加载中...</div>
    <div v-else-if="!item" class="text-center py-10">未找到对应的触发记录</div>

    <template v-else>
      <!-- 页面头部 -->
      <el-card class="mb-4">
        <div class="flex justify-between items-center">
          <div>
            <h1 class="text-xl font-bold">
              {{ item.stockName }} ({{ item.symbol }}) - {{ item.reason }}
            </h1>
            <div class="text-sm text-gray-500 mt-1">
              <span>触发时间: {{ item.createdAt }}</span>
              <span class="ml-4" v-if="triggerPrice != null">触发价格: ¥{{ triggerPrice }}</span>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            <el-button type="primary">导出</el-button>
            <el-button type="primary">分享</el-button>
          </div>
        </div>
      </el-card>

      <!-- 主体内容 -->
      <el-row :gutter="16" class="flex h-[1000px]">
        <!-- 左侧图表区 -->
        <el-col :span="16">
          <div class="space-y-4 flex flex-col h-full">
            <el-card class="flex-1">
              <template #header><div class="font-bold">K线图 (主图)</div></template>
              <div ref="klineChart" class="h-full"></div>
            </el-card>
            <el-card class="flex-1">
              <template #header><div class="font-bold">MACD指标 (子图1)</div></template>
              <div ref="macdChart" class="h-full"></div>
            </el-card>
            <el-card class="flex-1">
              <template #header><div class="font-bold">成交量 (子图2)</div></template>
              <div ref="volumeChart" class="h-full"></div>
            </el-card>
          </div>
        </el-col>

        <!-- 右侧信息区 -->
        <el-col :span="8">
          <div class="space-y-4 flex flex-col h-full">
            <el-card class="flex-1">
              <template #header><div class="font-bold">触发原因分析</div></template>
              <div class="text-sm text-gray-600">AI生成的原因总结 + 关键新闻摘要</div>
            </el-card>
            <el-card class="flex-1">
              <template #header><div class="font-bold">关键指标快照</div></template>
              <div class="text-sm space-y-2 p-2">
                <p>量比: {{ volumeRatioText }}</p>
                <p>涨跌幅: {{ changePercentText }}</p>
                <p>成交量: {{ currentVolumeText }}</p>
              </div>
            </el-card>
            <el-card class="flex-1">
              <template #header><div class="font-bold">历史触发对比</div></template>
              <div class="text-sm p-2">
                <p>该策略历史胜率: -</p>
                <el-button link type="primary">查看历史记录</el-button>
              </div>
            </el-card>
          </div>
        </el-col>
      </el-row>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, nextTick, watch, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import * as echarts from 'echarts';

type TriggerLogDto = {
  id: string;
  createdAt: string;
  symbol: string;
  stockName?: string;
  reason: string;
  subscriptionId?: string;
  sendStatus?: string;
  sendError?: string;
  snapshot: any;
  pattern?: any;
  indicator?: any;
  kline?: any; // K线数据
};

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const item = ref<TriggerLogDto | null>(null);
const chartData = ref<any>(null);

function formatNum(v: any, fixed: number = 2): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '-';
  return v.toFixed(fixed);
}

function formatVolume(v: any): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '-';
  if (Math.abs(v) >= 100000000) {
    return (v / 100000000).toFixed(2) + '亿';
  } else if (Math.abs(v) >= 10000) {
    return (v / 10000).toFixed(2) + '万';
  }
  return String(Math.trunc(v));
}

function pickTriggerPrice(x: any): number | null {
  const p1 = x?.snapshot?.stock?.currentPrice;
  if (typeof p1 === 'number' && Number.isFinite(p1)) return Number(p1.toFixed(2));
  const p2 = x?.snapshot?.stock?.closePrice;
  if (typeof p2 === 'number' && Number.isFinite(p2)) return Number(p2.toFixed(2));
  return null;
}

const triggerPrice = ref<number | null>(null);
const volumeRatioText = ref<string>('-');
const changePercentText = ref<string>('-');
const currentVolumeText = ref<string>('-');

// 图表容器引用
const klineChart = ref<HTMLElement | null>(null);
const macdChart = ref<HTMLElement | null>(null);
const volumeChart = ref<HTMLElement | null>(null);

let klineChartInstance: echarts.ECharts | null = null;
let macdChartInstance: echarts.ECharts | null = null;
let volumeChartInstance: echarts.ECharts | null = null;

async function fetchDetail() {
  loading.value = true;
  try {
    const id = String(route.params.id || '');
    const res = await api.get(`/trigger-logs/${id}`);
    const x = res.data.item;
    if (x) {
      item.value = { ...x } as TriggerLogDto;
      triggerPrice.value = pickTriggerPrice(x);

      const ratio = x?.snapshot?.indicator?.volume?.ratio;
      volumeRatioText.value = typeof ratio === 'number' && Number.isFinite(ratio) ? `x${formatNum(ratio, 2)}` : '-';

      const cp = x?.snapshot?.stock?.changePercent;
      changePercentText.value = typeof cp === 'number' && Number.isFinite(cp) ? `${formatNum(cp, 2)}%` : '-';

      const cv = x?.snapshot?.stock?.volume;
      currentVolumeText.value = formatVolume(cv);

      // 假设 x.kline 是API返回的K线数据数组
      if (x.kline && x.kline.length > 0) {
        chartData.value = processKlineData(x.kline, x.createdAt);
      }
    } else {
      item.value = null;
    }
  } finally {
    loading.value = false;
  }
}

watch(chartData, (newData) => {
  if (newData) {
    nextTick(() => {
      setTimeout(() => initCharts(newData), 100);
    });
  }
});

function initCharts(data: any) {
  if (!klineChart.value || !macdChart.value || !volumeChart.value || !data) {
    return;
  }

  klineChartInstance = echarts.init(klineChart.value);
  macdChartInstance = echarts.init(macdChart.value);
  volumeChartInstance = echarts.init(volumeChart.value);

  const { dates, fullDates, klineValues, volumes, macdValues, triggerIndex } = data;

  const formatAxisLabel = (v: any) => String(v || '');

  const klineTooltipFormatter = (params: any) => {
    const list = Array.isArray(params) ? params : [];
    if (list.length === 0) return '';
    const p = list[0];
    const idx = typeof p?.dataIndex === 'number' ? p.dataIndex : -1;
    const timeText = idx >= 0 && Array.isArray(fullDates) ? String(fullDates[idx] || '') : String(p?.axisValue || '');
    const v = Array.isArray(p?.data) ? p.data : [];
    const open = v[0];
    const close = v[1];
    const low = v[2];
    const high = v[3];
    return [
      timeText,
      `开: ${formatNum(open, 2)}`,
      `收: ${formatNum(close, 2)}`,
      `低: ${formatNum(low, 2)}`,
      `高: ${formatNum(high, 2)}`,
    ].join('<br/>');
  };

  const volumeTooltipFormatter = (params: any) => {
    const list = Array.isArray(params) ? params : [];
    if (list.length === 0) return '';
    const p = list[0];
    const idx = typeof p?.dataIndex === 'number' ? p.dataIndex : -1;
    const timeText = idx >= 0 && Array.isArray(fullDates) ? String(fullDates[idx] || '') : String(p?.axisValue || '');
    return [timeText, `成交量: ${formatVolume(p?.value)}`].join('<br/>');
  };

  const macdTooltipFormatter = (params: any) => {
    const list = Array.isArray(params) ? params : [];
    if (list.length === 0) return '';
    const idx = typeof list[0]?.dataIndex === 'number' ? list[0].dataIndex : -1;
    const timeText = idx >= 0 && Array.isArray(fullDates) ? String(fullDates[idx] || '') : String(list[0]?.axisValue || '');
    const byName = new Map<string, any>(list.map((p: any) => [String(p?.seriesName || ''), p?.value]));
    return [
      timeText,
      `DIF: ${formatNum(byName.get('DIF'), 4)}`,
      `DEA: ${formatNum(byName.get('DEA'), 4)}`,
      `MACD: ${formatNum(byName.get('MACD'), 4)}`,
    ].join('<br/>');
  };

  // K线图配置
  const markerIndex = typeof triggerIndex === 'number' && triggerIndex >= 0 ? triggerIndex : Math.max(0, dates.length - 1);
  const klineOption: echarts.EChartsOption = {
    grid: { left: 20, right: 20, top: 50, bottom: 28, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, formatter: klineTooltipFormatter },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine: { onZero: false },
      axisLabel: { formatter: formatAxisLabel, hideOverlap: true },
    },
    yAxis: { scale: true, splitArea: { show: true } },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
    ],
    series: [{
      type: 'candlestick',
      data: klineValues,
      markPoint: {
        data: [{
          name: '触发点',
          coord: [dates[markerIndex], klineValues[markerIndex]?.[1]],
          value: item.value?.reason,
          symbol: 'pin',
          symbolSize: 50,
        }]
      }
    }]
  };

  // MACD图配置
  const macdOption: echarts.EChartsOption = {
    grid: { left: 20, right: 20, top: 10, bottom: 10, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, formatter: macdTooltipFormatter },
    xAxis: { type: 'category', data: dates, axisLabel: { show: true, formatter: formatAxisLabel, hideOverlap: true } },
    yAxis: { scale: true },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
    ],
    series: [
      { name: 'DIF', type: 'line', data: macdValues.diff },
      { name: 'DEA', type: 'line', data: macdValues.dea },
      { name: 'MACD', type: 'bar', data: macdValues.macd }
    ]
  };

  // 成交量图配置
  const volumeOption: echarts.EChartsOption = {
    grid: { left: 20, right: 20, top: 10, bottom: 0, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, formatter: volumeTooltipFormatter },
    xAxis: { type: 'category', data: dates, axisLabel: { show: true, formatter: formatAxisLabel, hideOverlap: true } },
    yAxis: { 
      scale: true,
      axisLabel: {
        formatter: (v: any) => formatVolume(v)
      }
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none' }
    ],
    series: [{ name: '成交量', type: 'bar', data: volumes }]
  };

  klineChartInstance.setOption(klineOption);
  macdChartInstance.setOption(macdOption);
  volumeChartInstance.setOption(volumeOption);

  // 关联图表
  echarts.connect([klineChartInstance, macdChartInstance, volumeChartInstance]);
}

function backToList() {
  router.push('/trigger-logs');
}

onMounted(fetchDetail);

// --- 数据处理 ---
function processKlineData(kline: any[], triggerTime: string) {
  const dates: string[] = [];
  const fullDates: string[] = [];
  const klineValues = [];
  const volumes = [];
  const macdValues = { diff: [], dea: [], macd: [] };

  const parseTs = (s: any): number | null => {
    const t = Date.parse(String(s || '').trim());
    return Number.isFinite(t) ? t : null;
  };

  const formatDateLabel = (raw: any): string => {
    const s = String(raw || '').trim();
    if (!s) return '';
    const parts = s.split(' ');
    const timePart = parts[1] || '';
    if (!timePart) return '';
    return timePart.slice(0, 5);
  };

  for (const item of kline) {
    const rawDate = item.date;
    fullDates.push(String(rawDate || ''));
    dates.push(formatDateLabel(rawDate));
    klineValues.push([item.open, item.close, item.low, item.high]);
    volumes.push(item.volume);
    if (item.indicator?.macd) {
      macdValues.diff.push(item.indicator.macd.macdLine);
      macdValues.dea.push(item.indicator.macd.signalLine);
      macdValues.macd.push(item.indicator.macd.histogram);
    } else {
      macdValues.diff.push(NaN);
      macdValues.dea.push(NaN);
      macdValues.macd.push(NaN);
    }
  }

  let triggerIndex = fullDates.length - 1;
  const triggerTs = parseTs(triggerTime);
  if (triggerTs != null && fullDates.length > 0) {
    let bestIdx = triggerIndex;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < fullDates.length; i++) {
      const ts = parseTs(fullDates[i]);
      if (ts == null) continue;
      const diff = Math.abs(ts - triggerTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    triggerIndex = bestIdx;
  }

  if (volumeRatioText.value === '-' && volumes.length > 0) {
    const lookback = 20;
    const start = Math.max(0, triggerIndex - lookback);
    const base = volumes
      .slice(start, triggerIndex)
      .filter((v: any) => typeof v === 'number' && Number.isFinite(v) && v > 0) as number[];
    const cur = volumes[triggerIndex];
    if (typeof cur === 'number' && Number.isFinite(cur) && cur > 0 && base.length > 0) {
      const avg = base.reduce((a, b) => a + b, 0) / base.length;
      if (Number.isFinite(avg) && avg > 0) {
        volumeRatioText.value = `x${formatNum(cur / avg, 2)}`;
      }
    }
  }

  return { dates, fullDates, klineValues, volumes, macdValues, triggerIndex };
}

// --- 图表自适应 --- //
const handleResize = () => {
  klineChartInstance?.resize();
  macdChartInstance?.resize();
  volumeChartInstance?.resize();
};

window.addEventListener('resize', handleResize);

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  klineChartInstance?.dispose();
  macdChartInstance?.dispose();
  volumeChartInstance?.dispose();
});

</script>

<style scoped>
/* :deep(.el-card__body) {
  padding: 8px;
} */
</style>
