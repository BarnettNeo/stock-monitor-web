<template>
  <template v-if="isAuthPage">
    <router-view />
  </template>
  <el-container v-else>
    <el-aside width="220px">
      <div style="padding: 16px; font-weight: 700">Stock Monitor</div>
      <el-menu :default-active="$route.path" router>
        <el-menu-item index="/strategies">策略管理</el-menu-item>
        <el-menu-item index="/subscriptions">订阅管理</el-menu-item>
        <el-menu-item index="/trigger-logs">触发日志</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header style="display:flex; align-items:center; justify-content: space-between">
        <div>{{ pageTitle }}</div>
        <div style="display:flex; margin-left: auto; gap: 16px; font-size: 16px;">
          <div>当前{{ currentUser?.role === 'admin' ? '管理员' : '用户' }}: {{ currentUsername }}</div>
          <el-button link type="danger" @click="logout">退出</el-button>
        </div>
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, clearAuthToken } from './api';
import { ElMessageBox } from 'element-plus';

const route = useRoute();
const router = useRouter();

const isAuthPage = computed(() => {
  return route.path.startsWith('/login') || route.path.startsWith('/register');
});

const pageTitle = computed(() => {
  if (route.path.startsWith('/strategies')) return '策略管理';
  if (route.path.startsWith('/subscriptions')) return '订阅管理';
  if (route.path.startsWith('/trigger-logs')) return '触发日志';
  return 'Stock Monitor';
});

const currentUser = ref<{ userId: string; username: string; role: 'admin' | 'user' } | null>(null);
const currentUsername = computed(() => currentUser.value?.username || '-');

async function logout() {
  // 确定是否退出
  await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning',
  });
  clearAuthToken();
  router.replace('/login');
}

async function getUserInfo() {
  // 获取用户信息
  if (isAuthPage.value) {
    currentUser.value = null;
    return;
  }
  try {
    const res = await api.get('/auth/me');
    currentUser.value = res.data?.user || null;
  } catch {
    currentUser.value = null;
  }
}

onMounted(() => {
  getUserInfo();
});

watch(
  () => route.path,
  () => {
    getUserInfo();
  },
);
</script>

<style>
html,
body,
#app {
  height: 100%;
}

body {
  margin: 0;
}
</style>
