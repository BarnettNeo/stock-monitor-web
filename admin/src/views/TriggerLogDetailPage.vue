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
              <span class="ml-4" v-if="item.snapshot?.price">触发价格: ¥{{ item.snapshot.price }}</span>
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
                <p>量比: {{ item.snapshot.volumeRatio || '-' }}</p>
                <p>涨跌幅: {{ item.snapshot.changePercent || '-' }}%</p>
                <p>主力流入: {{ item.snapshot.mainFlowIn || '-' }}</p>
              </div>
            </el-card>
            <el-card class="flex-1">
              <template #header><div class="font-bold">历史触发对比</div></template>
              <div class="text-sm p-2">
                <p>该策略历史胜率: 67%</p>
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
      item.value = {
        ...x,
        snapshot: {
          ...x.snapshot,
          price: 1780,
          volumeRatio: 3.2,
          changePercent: 5.2,
          mainFlowIn: 12500000,
        },
      } as TriggerLogDto;

      // 假设 x.kline 是API返回的K线数据数组
      if (x.kline && x.kline.length > 0) {
        chartData.value = processKlineData(x.kline);
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

  const { dates, klineValues, volumes, macdValues } = data;

  // K线图配置
  const klineOption: echarts.EChartsOption = {
    xAxis: { type: 'category', data: dates, axisLine: { onZero: false } },
    yAxis: { scale: true, splitArea: { show: true } },
    series: [{
      type: 'candlestick',
      data: klineValues,
      markPoint: {
        data: [{
          name: '触发点',
          // 假设触发点是数据中的某一项，这里需要根据实际逻辑调整
          coord: [dates[Math.floor(dates.length / 2)], klineValues[Math.floor(dates.length / 2)][1]],
          value: item.value?.reason,
          symbol: 'pin',
          symbolSize: 50,
        }]
      }
    }]
  };

  // MACD图配置
  const macdOption: echarts.EChartsOption = {
    xAxis: { type: 'category', data: dates, axisLabel: { show: false } },
    yAxis: { scale: true },
    series: [
      { name: 'DIF', type: 'line', data: macdValues.diff },
      { name: 'DEA', type: 'line', data: macdValues.dea },
      { name: 'MACD', type: 'bar', data: macdValues.macd }
    ]
  };

  // 成交量图配置
  const volumeOption: echarts.EChartsOption = {
    xAxis: { type: 'category', data: dates, axisLabel: { show: false } },
    yAxis: { scale: true },
    series: [{ type: 'bar', data: volumes }]
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
function processKlineData(kline: any[]) {
  const dates = [];
  const klineValues = [];
  const volumes = [];
  const macdValues = { diff: [], dea: [], macd: [] };

  for (const item of kline) {
    dates.push(item.date);
    klineValues.push([item.open, item.close, item.low, item.high]);
    volumes.push(item.volume);
    if (item.indicator?.macd) {
      macdValues.diff.push(item.indicator.macd.diff);
      macdValues.dea.push(item.indicator.macd.dea);
      macdValues.macd.push(item.indicator.macd.macd);
    } else {
      macdValues.diff.push(NaN);
      macdValues.dea.push(NaN);
      macdValues.macd.push(NaN);
    }
  }

  return { dates, klineValues, volumes, macdValues };
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
