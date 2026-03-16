<template>
  <div>
    <el-card>
      <template #header>
        <div style="display:flex; justify-content: space-between; align-items:center">
          <div>触发日志</div>
          <div style="display:flex; align-items:center; gap: 12px">
            <el-select v-model="qType" placeholder="全部类型" clearable style="width: 140px">
              <el-option label="价格异动" value="price" />
              <el-option label="指标信号" value="indicator" />
              <el-option label="形态信号" value="pattern" />
            </el-select>
            <el-input
              v-model="qSymbol"
              placeholder="全部股票"
              clearable
              style="width: 160px"
            />
            <el-date-picker
              v-model="qDateRange"
              type="daterange"
              range-separator="-"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              value-format="YYYY-MM-DD"
            />
            <el-button @click="search">搜索</el-button>
          </div>
        </div>
      </template>

      <el-table :data="items" style="width: 100%" v-loading="loading">
        <el-table-column prop="createdAt" label="触发时间" width="180">
          <template #default="scope">
            {{ formatDate(scope.row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column prop="symbol" label="股票" min-width="160">
          <template #default="scope">
            {{ scope.row.symbol }} {{ scope.row.stockName || '' }}
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="异动类型" min-width="220">
          <template #default="scope">
            {{ scope.row.reason }}
          </template>
        </el-table-column>
        <el-table-column prop="sendStatus" label="推送状态" width="120">
          <template #default="scope">
            <el-tag v-if="scope.row.sendStatus === 'SENT'" type="success">成功</el-tag>
            <el-tag v-else-if="scope.row.sendStatus === 'FAILED'" type="danger">失败</el-tag>
            <el-tag v-else type="info">未推送</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="viewDetail(scope.row)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div style="display:flex; justify-content:flex-end; margin-top: 16px">
        <el-pagination
          layout="prev, pager, next"
          :total="total"
          :page-size="pageSize"
          :current-page="currentPage"
          @current-change="handlePageChange"
          hide-on-single-page
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';

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

const router = useRouter();

const qType = ref<string | undefined>(undefined);
const qSymbol = ref('');
const qDateRange = ref<[string, string] | null>(null);

const pageSize = 20;
const currentPage = ref(1);
const loading = ref(false);
const items = ref<TriggerLogDto[]>([]);
const total = ref(0);

async function fetchList() {
  loading.value = true;
  try {
    const res = await api.get('/trigger-logs', {
      params: {
        page: currentPage.value,
        pageSize,
        symbol: qSymbol.value || undefined,
        startDate: qDateRange.value && qDateRange.value.length === 2 ? qDateRange.value[0] : undefined,
        endDate: qDateRange.value && qDateRange.value.length === 2 ? qDateRange.value[1] : undefined,
        type: qType.value || undefined,
      },
    });
    const list = (res.data.items || []).map((x: any) => ({
      ...x,
      snapshotJson: JSON.stringify(x.snapshot, null, 2),
      pattern: x.snapshot?.threshold?.pattern,
      indicator: x.snapshot?.indicator,
    }));
    items.value = list;
    total.value = typeof res.data.total === 'number' ? res.data.total : list.length;
  } finally {
    loading.value = false;
  }
}

function search() {
  currentPage.value = 1;
  fetchList();
}

watch([qSymbol, qDateRange], () => {
  currentPage.value = 1;
});

watch(qType, () => {
  currentPage.value = 1;
  fetchList();
});

function handlePageChange(page: number) {
  currentPage.value = page;
  fetchList();
}

function viewDetail(row: TriggerLogDto) {
  router.push(`/trigger-logs/${row.id}`);
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
