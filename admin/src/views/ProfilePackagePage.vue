<template>
  <div>
    <el-card v-loading="loading">
      <template #header>
        <div style="display:flex; justify-content: space-between; align-items:center">
          <div>我的套餐</div>
          <el-button @click="fetchPackage">刷新</el-button>
        </div>
      </template>

      <template v-if="pkg">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="当前套餐">
            <el-tag :type="pkg.userPackage === 'vip' ? 'success' : 'info'">{{ packageLabel }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="有效期">
            <span>{{ expireText }}</span>
            <el-tag v-if="!pkg.packageActive" type="danger" size="small" style="margin-left: 8px">已过期</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="可创建策略上限">
            {{ pkg.maxStrategyCount }}
          </el-descriptions-item>
          <el-descriptions-item label="已创建策略数量">
            {{ pkg.strategyCount }}
          </el-descriptions-item>
          <el-descriptions-item label="剩余可创建策略数量">
            <el-tag :type="pkg.remainStrategyCount > 0 ? 'success' : 'warning'">{{ pkg.remainStrategyCount }}</el-tag>
          </el-descriptions-item>
        </el-descriptions>

        <el-divider />
        <div style="color: #666; line-height: 1.8">
          <div>免费试用版（5天）：最多 3 个监控策略，企业微信推送。</div>
          <div>基础付费版（99 元 / 月）：最多 20 个监控策略，企业微信 / 钉钉推送，自动报告生成。</div>
        </div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';

type PackageDto = {
  userId: string;
  userPackage: 'free' | 'vip';
  packageExpire: string | null;
  packageActive: boolean;
  maxStrategyCount: number;
  strategyCount: number;
  remainStrategyCount: number;
};

const loading = ref(false);
const pkg = ref<PackageDto | null>(null);

const packageLabel = computed(() => {
  if (!pkg.value) return '-';
  return pkg.value.userPackage === 'vip' ? '基础付费版' : '免费试用版';
});

const expireText = computed(() => {
  if (!pkg.value?.packageExpire) return '-';
  const d = new Date(pkg.value.packageExpire);
  if (Number.isNaN(d.getTime())) return pkg.value.packageExpire;
  return d.toLocaleString('zh-CN');
});

async function fetchPackage() {
  loading.value = true;
  try {
    const res = await api.get('/users/me/package');
    pkg.value = res.data?.item || null;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '获取套餐信息失败');
  } finally {
    loading.value = false;
  }
}

onMounted(fetchPackage);
</script>
