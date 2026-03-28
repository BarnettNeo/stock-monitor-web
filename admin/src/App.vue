<template>
  <template v-if="isAuthPage || isScreenPage">
    <router-view />
  </template>

  <el-container v-else>
    <el-aside :width="asideWidth" class="app-aside">
      <div class="aside-header" :class="{ collapsed: isCollapsed }">
        <div v-if="!isCollapsed" class="brand">Stock Monitor</div>
        <el-button
          class="collapse-btn"
          text
          circle
          :icon="isCollapsed ? Expand : Fold"
          @click="toggleCollapse"
          :title="isCollapsed ? '展开菜单' : '折叠菜单'"
        />
      </div>
      <el-menu :default-active="$route.path" router :collapse="isCollapsed" :collapse-transition="false">
        <el-menu-item index="/screen">
          <el-icon><Monitor /></el-icon>
          <span>大盘监控</span>
        </el-menu-item>

        <el-sub-menu index="/config">
          <template #title>
            <el-icon><Setting /></el-icon>
            <span>配置中心</span>
          </template>

          <el-menu-item index="/strategies">
            <el-icon><Document /></el-icon>
            <span>策略列表</span>
          </el-menu-item>

          <el-menu-item index="/subscriptions">
            <el-icon><Bell /></el-icon>
            <span>订阅列表</span>
          </el-menu-item>

          <el-menu-item index="/trigger-logs">
            <el-icon><Files /></el-icon>
            <span>触发记录</span>
          </el-menu-item>

        </el-sub-menu>

        <el-menu-item index="/profile/package">
          <el-icon><User /></el-icon>
          <span>个人中心</span>
        </el-menu-item>

        <el-menu-item v-if="isAdmin" index="/users">
          <el-icon><UserFilled /></el-icon>
          <span>用户管理</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header style="display:flex; align-items:center; justify-content: space-between">
        <div>{{ pageTitle }}</div>
        <CurrentUserBar :user="currentUser" @update:user="onUserUpdate" />
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>

  <AgentChatFloat v-if="!isAuthPage" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Monitor, Setting, Document, Bell, Files, User, UserFilled, Fold, Expand } from '@element-plus/icons-vue';

import AgentChatFloat from './components/AgentChatFloat.vue';
import CurrentUserBar from './components/CurrentUserBar.vue';

type UserInfo = {
  userId: string;
  username: string;
  role: 'admin' | 'user' | string;
  status?: string;
};

const route = useRoute();

const COLLAPSE_KEY = 'admin_sidebar_collapsed';

const isCollapsed = ref(false);
try {
  const raw = localStorage.getItem(COLLAPSE_KEY);
  isCollapsed.value = raw === '1' || raw === 'true';
} catch {
  // ignore
}

watch(
  () => isCollapsed.value,
  (v: boolean) => {
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      // ignore
    }
  },
);

const asideWidth = computed(() => (isCollapsed.value ? '64px' : '220px'));

function toggleCollapse() {
  isCollapsed.value = !isCollapsed.value;
}

const currentUser = ref<UserInfo | null>(null);
const isAdmin = computed(() => currentUser.value?.role === 'admin');

function onUserUpdate(u: UserInfo | null) {
  currentUser.value = u;
}

const isAuthPage = computed(() => route.path.startsWith('/login') || route.path.startsWith('/register'));
const isScreenPage = computed(() => route.path.startsWith('/screen'));

const pageTitle = computed(() => {
  if (route.path.startsWith('/screen')) return '大盘监控';
  if (route.path.startsWith('/strategies')) return '策略列表';
  if (route.path.startsWith('/subscriptions')) return '订阅列表';
  if (route.path.startsWith('/users')) return '用户管理';
  if (route.path.startsWith('/profile/package')) return '个人中心';
  if (route.path.startsWith('/trigger-logs')) return '触发记录';
  return 'Stock Monitor';
});
</script>

<style>
html,
body,
#app {
  width: 100%;
  height: 100%;
}

body {
  margin: 0;
}

.app-aside {
  border-right: 1px solid rgba(0, 0, 0, 0.08);
  overflow-x: hidden;
}

.aside-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 12px 16px;
}

.aside-header.collapsed {
  justify-content: center;
  padding: 12px;
}

.brand {
  font-weight: 700;
  user-select: none;
}
</style>

