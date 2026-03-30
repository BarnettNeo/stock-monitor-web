<template>
  <div>
    <el-card>
      <template #header>
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="font-bold">策略列表</div>
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <el-input v-model="qName" placeholder="名称" class="w-full sm:w-44" clearable />
            <el-input v-model="qUsername" placeholder="用户名" class="w-full sm:w-44" clearable />
            <el-button class="w-full sm:w-auto" @click="search">查询</el-button>

            <el-button class="w-full sm:w-auto !ml-0" type="primary" @click="openCreate('')">新增策略</el-button>
          </div>
        </div>
      </template>

      <div class="table-scroll">
        <el-table :data="items" style="width: 100%" v-loading="loading">
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column prop="symbols" label="股票代码" min-width="140" />
          <el-table-column prop="stockNames" label="股票名称" min-width="150" />
          <el-table-column prop="alertMode" label="告警方式" min-width="250">
          <template #default="scope">
            <template v-if="scope.row.alertMode === 'target'">
              目标价触发
              <span style="color: #666">
                （涨至: {{ scope.row.targetPriceUp ?? '-' }} / 跌至: {{ scope.row.targetPriceDown ?? '-' }}）
              </span>
            </template>
            <template v-else>
              大幅异动监控
              <span style="color: #666">（阈值: {{ scope.row.priceAlertPercent ?? '-' }}%）</span>
            </template>
          </template>
          </el-table-column>
          <el-table-column v-if="!isMobile" prop="intervalMs" label="推送间隔(分)" width="120">
          <template #default="scope">
            {{ typeof scope.row.intervalMs === 'number' ? scope.row.intervalMs / 60000 : '-' }}
          </template>
          </el-table-column>
          <el-table-column v-if="!isMobile" label="技术指标" min-width="220">
          <template #default="scope">
            <el-tag v-if="scope.row.enableMacdGoldenCross" size="small" style="margin-right: 0.25rem">MACD</el-tag>
            <el-tag v-if="scope.row.enableRsiOversold" size="small" style="margin-right: 0.25rem">RSI超卖</el-tag>
            <el-tag v-if="scope.row.enableRsiOverbought" size="small" style="margin-right: 0.25rem">RSI超买</el-tag>
            <el-tag v-if="scope.row.enableMovingAverages" size="small" style="margin-right: 0.25rem">均线</el-tag>
            <el-tag v-if="scope.row.enablePatternSignal" size="small" style="margin-right: 0.25rem">突破回踩信号</el-tag>
            <span
              v-if="
                !scope.row.enableMacdGoldenCross &&
                !scope.row.enableRsiOversold &&
                !scope.row.enableRsiOverbought &&
                !scope.row.enableMovingAverages &&
                !scope.row.enablePatternSignal
              "
              style="color: #999"
            >
              -
            </span>
          </template>
          </el-table-column>
          <el-table-column v-if="!isMobile" prop="cooldownMinutes" label="冷却(分)" width="100" />
          <el-table-column v-if="!isMobile" label="推送方式" width="120">
          <template #default="scope">
            <template v-for="subId in (scope.row.subscriptionIds || [])" :key="subId">
              <el-tag
                v-for="sub in subscriptions"
                :key="sub.id"
                v-show="sub.id === subId"
                :type="sub.type === 'dingtalk' ? 'primary' : 'success'"
                size="small"
                style="margin-right: 0.25rem"
              >
                {{ sub.type === 'dingtalk' ? '钉钉' : '企微' }}
              </el-tag>
            </template>
            <span v-if="!scope.row.subscriptionIds?.length" style="color: #999">-</span>
          </template>
          </el-table-column>
          <el-table-column prop="enabled" label="启用" width="75">
          <template #default="scope">
            <el-tag :type="scope.row.enabled ? 'success' : 'info'">{{ scope.row.enabled ? '是' : '否' }}</el-tag>
          </template>
          </el-table-column>
          <el-table-column v-if="!isMobile" prop="createdByUsername" label="创建人" width="100" />
          <el-table-column v-if="!isMobile" prop="marketTimeOnly" label="交易时间" width="100">
          <template #default="scope">
            <span style="color: #666">{{ scope.row.marketTimeOnly === false ? '不限' : '仅交易时段' }}</span>
          </template>
          </el-table-column>
          <el-table-column label="操作" width="112" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
            <el-button link type="danger" @click="remove(scope.row.id)">删除</el-button>
          </template>
          </el-table-column>
        </el-table>
      </div>

      <div style="display:flex; justify-content:flex-end; margin-top: 1rem">
        <el-pagination
          layout="total, sizes, prev, pager, next"
          :total="total"
          :page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :current-page="currentPage"
          @current-change="handlePageChange"
          @size-change="handleSizeChange"
          hide-on-single-page
        />
      </div>
    </el-card>


    <el-dialog v-model="dialogVisible" :title="editing ? '编辑策略' : '新增策略'" width="760px">
      <el-alert
        v-if="isFreePackage"
        type="warning"
        :closable="false"
        style="margin-bottom: 0.75rem"
        title="免费版创建策略仅支持基础配置，RSI超卖 / RSI超买 / 均线信号 / 形态信号已限制。"
      />

      <el-form ref="formRef" :model="form" :rules="rules" :label-width="!isMobile ? '130px' : 'auto'">
        <el-form-item label="策略名称" prop="name">
          <el-input v-model="form.name" />
        </el-form-item>

        <el-row :gutter="24">
          <el-col :span="11">
            <el-form-item label="启用">
              <el-switch v-model="form.enabled" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="仅交易时间推送">
              <el-switch v-model="form.marketTimeOnly" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="告警方式">
          <el-radio-group v-model="form.alertMode">
            <el-radio label="percent">大幅异动监控</el-radio>
            <el-radio label="target">目标价触发</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-row v-if="form.alertMode === 'target'" :gutter="12">
          <el-col :span="!isMobile ? 12 : 24">
            <el-form-item label="上涨目标价">
              <el-input-number
                v-model="form.targetPriceUp"
                :min="0"
                :step="0.01"
                :precision="2"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="!isMobile ? 12 : 24">
            <el-form-item label="下跌目标价">
              <el-input-number
                v-model="form.targetPriceDown"
                :min="0"
                :step="0.01"
                :precision="2"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row v-else :gutter="12">
          <el-col :span="!isMobile ? 12 : 24">
            <el-form-item label="涨跌幅阈值(%)" prop="priceAlertPercent">
              <el-input-number
                v-model="form.priceAlertPercent"
                :min="0.01"
                :step="0.01"
                :precision="2"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12" />
        </el-row>

        <el-form-item label="绑定推送订阅">
          <el-select
            v-model="form.subscriptionIds"
            multiple
            filterable
            style="width: 100%"
            placeholder="选择推送订阅（留空=仅记录日志不推送）"
          >
            <el-option v-for="s in selectableSubscriptions" :key="s.id" :label="`${s.name} (${s.type})`" :value="s.id" />
          </el-select>
        </el-form-item>

        <el-form-item label="股票列表" prop="symbols">
          <el-input v-model="form.symbols" placeholder="例如：sh600519,sz000001 或 贵州茅台" />
        </el-form-item>

        <el-row :gutter="12">
          <el-col :span="!isMobile ? 12 : 24">
            <el-form-item label="推送间隔(分)" prop="intervalMs">
              <el-input-number v-if="!isMobile" v-model="form.intervalMs" :min="1" :step="1" style="width: 100%" />
              <el-input
                v-else
                :model-value="form.intervalMs == null ? '' : String(form.intervalMs)"
                @update:model-value="(v:any) => setNumField('intervalMs', v, { min: 1, integer: true })"
                type="number"
                inputmode="numeric"
                placeholder="1"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-divider content-position="left">技术面深度分析指标</el-divider>

        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="MACD金叉/死叉">
              <el-switch v-model="form.enableMacdGoldenCross" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="RSI 超卖">
              <el-switch v-model="form.enableRsiOversold" :disabled="isFreePackage" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="RSI 超买">
              <el-switch v-model="form.enableRsiOverbought" :disabled="isFreePackage" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="均线信号">
              <el-switch v-model="form.enableMovingAverages" :disabled="isFreePackage" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="突破回踩信号">
              <el-switch v-model="form.enablePatternSignal" :disabled="isFreePackage" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="24">
          <el-col :span="!isMobile ? 12 : 24">
            <el-form-item label="冷却时间(分)" prop="cooldownMinutes">
              <el-input-number v-model="form.cooldownMinutes" :min="1" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';
import { useListFetcher } from '../composables/useListFetcher';
import { useIsMobile } from '../composables/useIsMobile';

const { isMobile } = useIsMobile();

function setNumField(
  key: string,
  raw: unknown,
  opts: { min?: number; precision?: number; integer?: boolean } = {},
): void {
  const s = String(raw ?? '').trim();
  if (!s) {
    (form.value as any)[key] = undefined;
    return;
  }

  let n = Number(s);
  if (!Number.isFinite(n)) return;

  if (opts.integer) n = Math.trunc(n);
  if (typeof opts.min === 'number' && n < opts.min) n = opts.min;
  if (typeof opts.precision === 'number') n = Number(n.toFixed(opts.precision));

  (form.value as any)[key] = n;
}

type StrategyDto = {
  id: string;
  name: string;
  createdByUsername?: string | null;
  enabled: boolean;
  symbols: string;
  stockNames: string;
  subscriptionIds?: string[];
  marketTimeOnly?: boolean;
  alertMode?: 'percent' | 'target';
  targetPriceUp?: number;
  targetPriceDown?: number;
  priceAlertPercent?: number;
  intervalMs?: number;
  cooldownMinutes?: number;
  enableMacdGoldenCross?: boolean;
  enableRsiOversold?: boolean;
  enableRsiOverbought?: boolean;
  enableMovingAverages?: boolean;
  enablePatternSignal?: boolean;
};

type SubscriptionDto = {
  id: string;
  userId?: string | null;
  name: string;
  type: 'dingtalk' | 'wecom_robot' | 'wecom_app';
  createdByUsername?: string | null;
};

type PackageInfo = {
  userPackage: 'free' | 'vip';
  packageExpire: string | null;
  packageActive: boolean;
  maxStrategyCount: number;
  strategyCount: number;
  remainStrategyCount: number;
};

const route = useRoute();
const router = useRouter();

const qName = ref('');
const qUsername = ref('');

const currentUser = ref<{ userId: string; username: string; role: 'admin' | 'user' } | null>(null);
const packageInfo = ref<PackageInfo | null>(null);
const isFreePackage = computed(() => packageInfo.value?.userPackage === 'free');

const loading = ref(false);
const items = ref<StrategyDto[]>([]);
const total = ref(0);
const pageSize = ref(10);
const currentPage = ref(1);

async function fetchList() {
  loading.value = true;
  try {
    const res = await api.get('/strategies', {
      params: {
        page: currentPage.value,
        pageSize: pageSize.value,
        name: qName.value || undefined,
        username: qUsername.value || undefined,
      },
    });
    const list = Array.isArray(res.data?.items) ? res.data.items : [];
    items.value = list;
    total.value = typeof res.data?.total === 'number' ? res.data.total : list.length;
  } finally {
    loading.value = false;
  }
}

function search() {
  currentPage.value = 1;
  fetchList();
}

function handlePageChange(page: number) {
  currentPage.value = page;
  fetchList();
}

function handleSizeChange(size: number) {
  pageSize.value = size;
  currentPage.value = 1;
  fetchList();
}


const { items: subscriptions, fetchList: fetchSubscriptions } = useListFetcher<SubscriptionDto>(async () => {
  const params =
    currentUser.value && currentUser.value.role !== 'admin'
      ? { username: currentUser.value.username }
      : undefined;
  const res = await api.get('/subscriptions', {
    params: {
      ...(params || {}),
      page: 1,
      pageSize: 200,
    },
  });
  return res.data.items;

});

const selectableSubscriptions = computed(() => {
  if (currentUser.value?.role === 'admin') return subscriptions.value;
  const uid = currentUser.value?.userId;
  if (!uid) return [];
  return subscriptions.value.filter((s) => s.userId === uid);
});

const dialogVisible = ref(false);
const editing = ref(false);
const editingId = ref<string | null>(null);
const formRef = ref<any>(null);

const rules = {
  name: [{ required: true, message: '请输入策略名称', trigger: 'blur' }],
  symbols: [{ required: true, message: '请输入股票列表', trigger: 'blur' }],
  intervalMs: [
    { required: true, message: '请输入推送时间间隔', trigger: 'change' },
    {
      validator: (_: any, value: any, cb: any) => {
        if (typeof value !== 'number' || value < 1) return cb(new Error('推送间隔必须 >= 1 分钟'));
        cb();
      },
      trigger: 'change',
    },
  ],
  cooldownMinutes: [
    { required: true, message: '请输入冷却时间', trigger: 'change' },
    {
      validator: (_: any, value: any, cb: any) => {
        if (typeof value !== 'number' || value < 1) return cb(new Error('冷却时间必须 >= 1 分钟'));
        cb();
      },
      trigger: 'change',
    },
  ],
  priceAlertPercent: [
    {
      validator: (_: any, value: any, cb: any) => {
        if ((form.value as any).alertMode !== 'percent') return cb();
        if (typeof value !== 'number' || value < 0.1) return cb(new Error('涨跌幅阈值必须 >= 0.1%'));
        cb();
      },
      trigger: 'change',
    },
  ],
} as const;

const form = ref({
  name: '',
  enabled: true,
  marketTimeOnly: true,
  symbols: '',
  subscriptionIds: [] as string[],
  alertMode: 'percent' as 'percent' | 'target',
  targetPriceUp: undefined as number | undefined,
  targetPriceDown: undefined as number | undefined,
  intervalMs: 1,
  cooldownMinutes: 60,
  priceAlertPercent: 2,
  enableMacdGoldenCross: true,
  enableRsiOversold: true,
  enableRsiOverbought: true,
  enableMovingAverages: false,
  enablePatternSignal: true,
});

function enforceFreeIndicatorConstraints() {
  if (!isFreePackage.value) return;
  form.value.enableRsiOversold = false;
  form.value.enableRsiOverbought = false;
  form.value.enableMovingAverages = false;
  form.value.enablePatternSignal = false;
}


function openCreate(code = '') {
  fetchSubscriptions();
  editing.value = false;
  editingId.value = null;
  form.value = {
    name: '',
    enabled: true,
    marketTimeOnly: true,
    symbols: code || '',
    subscriptionIds: [],
    alertMode: 'percent',
    targetPriceUp: undefined,
    targetPriceDown: undefined,
    intervalMs: 1,
    cooldownMinutes: 60,
    priceAlertPercent: 2,
    enableMacdGoldenCross: true,
    enableRsiOversold: true,
    enableRsiOverbought: true,
    enableMovingAverages: false,
    enablePatternSignal: true,
  };
  enforceFreeIndicatorConstraints();
  dialogVisible.value = true;
}

function openEdit(row: any) {
  fetchSubscriptions();
  editing.value = true;
  editingId.value = row.id;
  api.get(`/strategies/${row.id}`).then((res) => {
    form.value = res.data.item;
    form.value.intervalMs = res.data.item.intervalMs ? res.data.item.intervalMs / 60000 : 1;
    (form.value as any).marketTimeOnly = res.data.item.marketTimeOnly !== false;
    (form.value as any).alertMode = (res.data.item.alertMode || 'percent') as any;
    (form.value as any).targetPriceUp = (res.data.item.targetPriceUp ?? undefined) as any;
    (form.value as any).targetPriceDown = (res.data.item.targetPriceDown ?? undefined) as any;
    if (!Array.isArray((form.value as any).subscriptionIds)) {
      (form.value as any).subscriptionIds = [];
    }
    enforceFreeIndicatorConstraints();
    dialogVisible.value = true;
  });
}

async function save() {
  try {
    await formRef.value?.validate();
    enforceFreeIndicatorConstraints();

    const alertMode = ((form.value as any).alertMode || 'percent') as 'percent' | 'target';

    const dataToSave = {
      ...form.value,
      alertMode,
      marketTimeOnly: (form.value as any).marketTimeOnly !== false,
      targetPriceUp:
        alertMode === 'target' && typeof (form.value as any).targetPriceUp === 'number' && (form.value as any).targetPriceUp > 0
          ? (form.value as any).targetPriceUp
          : undefined,
      targetPriceDown:
        alertMode === 'target' && typeof (form.value as any).targetPriceDown === 'number' && (form.value as any).targetPriceDown > 0
          ? (form.value as any).targetPriceDown
          : undefined,
      priceAlertPercent:
        alertMode === 'percent' && typeof (form.value as any).priceAlertPercent === 'number'
          ? (form.value as any).priceAlertPercent
          : undefined,
      intervalMs: form.value.intervalMs * 60000,
    };

    if (editing.value && editingId.value) {
      await api.put(`/strategies/${editingId.value}`, dataToSave);
    } else {
      await api.post('/strategies', dataToSave);
    }
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    await fetchList();
  } catch (error: any) {
    const msg = error?.response?.data?.message || error?.message || '保存失败';
    ElMessage.error(msg);
  }
}

async function remove(id: string) {
  try {
    await ElMessageBox.confirm('确定要删除这条策略吗？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    });
    await api.delete(`/strategies/${id}`);
    await fetchList();
    ElMessage.success('删除成功');
  } catch (error: any) {
    if (error === 'cancel') return;
    ElMessage.error(error?.response?.data?.message || error?.message || '删除失败');
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

async function getPackageInfo() {
  try {
    const res = await api.get('/users/me/package');
    packageInfo.value = res.data?.item || null;
  } catch {
    packageInfo.value = null;
  }
}

function consumeCreateQueryAndOpenDialog(): void {
  const v = (route.query as any)?.create;
  const shouldOpen = v === '1' || v === 'true';
  if (!shouldOpen) return;
  const code = (route.query as any)?.code || '';
  openCreate(code);
  const { create, ...rest } = (route.query as any) || {};
  router.replace({ path: route.path, query: rest });
}

watch(isFreePackage, () => {
  enforceFreeIndicatorConstraints();
});

onMounted(async () => {
  await getUserInfo();
  await getPackageInfo();
  fetchList();
  fetchSubscriptions();
  consumeCreateQueryAndOpenDialog();
});
</script>
