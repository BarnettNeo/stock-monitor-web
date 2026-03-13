<template>
  <el-row :gutter="12">
    <el-col :span="10">
      <el-card>
        <template #header>
          <div style="display:flex; justify-content: space-between; align-items:center">
            <div>触发日志</div>
            <el-button @click="fetchList">刷新</el-button>
          </div>
        </template>

        <el-table :data="items" height="600" v-loading="loading" @row-click="select">
          <el-table-column prop="createdAt" label="时间" width="170">
            <template #default="scope">
              {{ formatDate(scope.row.createdAt) }}
            </template>
          </el-table-column>
          <el-table-column prop="symbol" label="股票" width="120" />
          <el-table-column prop="sendStatus" label="发送" width="110">
            <template #default="scope">
              <el-tag
                v-if="scope.row.sendStatus"
                :type="scope.row.sendStatus === 'SENT' ? 'success' : (scope.row.sendStatus === 'FAILED' ? 'danger' : 'info')"
              >
                {{ scope.row.sendStatus }}
              </el-tag>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column prop="reason" label="原因" />
        </el-table>
      </el-card>
    </el-col>

    <el-col :span="14">
      <el-card>
        <template #header>
          <div>详情（为什么触发）</div>
        </template>

        <div v-if="!selected">选择左侧一条日志查看详情</div>
        <div v-else>
          <el-descriptions :column="1" border>
            <el-descriptions-item label="时间">{{ formatDate(selected.createdAt) }}</el-descriptions-item>
            <el-descriptions-item label="股票">{{ selected.symbol }} {{ selected.stockName || '' }}</el-descriptions-item>
            <el-descriptions-item label="触发原因">{{ selected.reason }}</el-descriptions-item>
            <el-descriptions-item label="订阅ID">{{ selected.subscriptionId || '-' }}</el-descriptions-item>
            <el-descriptions-item label="发送状态">{{ selected.sendStatus || '-' }}</el-descriptions-item>
            <el-descriptions-item v-if="selected.sendError" label="发送错误">
              <span style="color: #d03050">{{ selected.sendError }}</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-divider />

          <div v-if="selected.pattern" style="font-weight: 700; margin-bottom: 8px">形态信号</div>
          <el-descriptions v-if="selected.pattern" :column="1" border>
            <el-descriptions-item label="类型">{{ selected.pattern.type }}</el-descriptions-item>
            <el-descriptions-item label="方向">{{ selected.pattern.signal }}</el-descriptions-item>
            <el-descriptions-item label="强度">{{ selected.pattern.strength }}</el-descriptions-item>
            <el-descriptions-item label="解读">{{ selected.pattern.message }}</el-descriptions-item>
          </el-descriptions>

          <el-divider v-if="selected.indicator" />
          <div v-if="selected.indicator" style="font-weight: 700; margin-bottom: 8px">技术指标</div>
          <el-descriptions v-if="selected.indicator" :column="1" border>
            <el-descriptions-item v-if="selected.indicator.macd" label="MACD">
              {{ selected.indicator.macd.trend }}
            </el-descriptions-item>
            <el-descriptions-item v-if="selected.indicator.rsi" label="RSI">
              {{ selected.indicator.rsi.value }} ({{ selected.indicator.rsi.status }})
            </el-descriptions-item>
            <el-descriptions-item v-if="selected.indicator.movingAverages" label="均线趋势">
              {{ selected.indicator.movingAverages.trend }}
            </el-descriptions-item>
          </el-descriptions>

          <el-divider />
          <div style="font-weight: 700; margin-bottom: 8px">数据快照</div>
          <pre style="white-space: pre-wrap">{{ selected.snapshotJson }}</pre>
        </div>
      </el-card>
    </el-col>
  </el-row>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { useListFetcher } from '../composables/useListFetcher';

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
  snapshotJson: string;
  pattern?: any;
  indicator?: any;
};

const { loading, items, fetchList } = useListFetcher<TriggerLogDto>(async () => {
  const res = await api.get('/trigger-logs');
  return res.data.items.map((x: any) => ({
    ...x,
    snapshotJson: JSON.stringify(x.snapshot, null, 2),
    pattern: x.snapshot?.threshold?.pattern,
    indicator: x.snapshot?.indicator,
  }));
});
const selected = ref<TriggerLogDto | null>(null);

function select(row: any) {
  selected.value = row;
}
function formatDate(isoString: string): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

onMounted(fetchList);
</script>
