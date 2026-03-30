<template>
  <el-config-provider :size="elementSize">
    <template v-if="isAuthPage || isScreenPage">
      <router-view />
    </template>

    <el-container v-else class="app-shell">
      <!-- Desktop aside -->
      <el-aside v-show="!isMobile" :width="asideWidth" class="app-aside">
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

      <!-- Mobile drawer menu (simplified entry points) -->
      <el-drawer
        v-model="mobileMenuOpen"
        direction="ltr"
        size="82%"
        :with-header="false"
        class="mobile-menu-drawer"
      >
        <div class="drawer-header">
          <div class="brand">Stock Monitor</div>
          <el-button text circle :icon="Close" @click="mobileMenuOpen = false" aria-label="关闭菜单" />
        </div>

        <el-menu :default-active="$route.path" router :collapse="false" :collapse-transition="false" class="drawer-menu">
          <el-menu-item index="/screen" @click="mobileMenuOpen = false">
            <el-icon><Monitor /></el-icon>
            <span>大盘监控</span>
          </el-menu-item>
          <el-menu-item index="/strategies" @click="mobileMenuOpen = false">
            <el-icon><Document /></el-icon>
            <span>策略列表</span>
          </el-menu-item>
          <el-menu-item index="/subscriptions" @click="mobileMenuOpen = false">
            <el-icon><Bell /></el-icon>
            <span>订阅列表</span>
          </el-menu-item>
          <el-menu-item index="/trigger-logs" @click="mobileMenuOpen = false">
            <el-icon><Files /></el-icon>
            <span>触发记录</span>
          </el-menu-item>
          <el-menu-item index="/profile/package" @click="mobileMenuOpen = false">
            <el-icon><User /></el-icon>
            <span>个人中心</span>
          </el-menu-item>
          <el-menu-item v-if="isAdmin" index="/users" @click="mobileMenuOpen = false">
            <el-icon><UserFilled /></el-icon>
            <span>用户管理</span>
          </el-menu-item>
        </el-menu>
      </el-drawer>

      <el-container class="app-content">
        <el-header class="app-header">
          <div class="header-left">
            <el-button
              v-if="isMobile"
              class="menu-btn"
              text
              circle
              :icon="MenuIcon"
              @click="mobileMenuOpen = true"
              aria-label="打开菜单"
            />
            <div class="page-title">{{ pageTitle }}</div>
          </div>

          <CurrentUserBar
            :user="currentUser"
            @update:user="onUserUpdate"
            :fontSize="isMobile ? '14px' : '16px'"
            :gapPx="isMobile ? 8 : 16"
            :buttonSize="isMobile ? 'large' : 'default'"
          />
        </el-header>

        <el-main class="app-main">
          <router-view />
        </el-main>
      </el-container>
    </el-container>

    <AgentChatFloat v-if="!isAuthPage" />
  </el-config-provider>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Monitor, Setting, Document, Bell, Files, User, UserFilled, Fold, Expand, Menu as MenuIcon, Close } from '@element-plus/icons-vue';

import AgentChatFloat from './components/AgentChatFloat.vue';
import CurrentUserBar from './components/CurrentUserBar.vue';
import { useIsMobile } from './composables/useIsMobile';

type UserInfo = {
  userId: string;
  username: string;
  role: 'admin' | 'user' | string;
  status?: string;
};

const route = useRoute();
const { isMobile } = useIsMobile();

const mobileMenuOpen = ref(false);

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

watch(
  () => route.path,
  () => {
    // Close mobile menu when navigating.
    mobileMenuOpen.value = false;
  },
);

const elementSize = computed(() => {
  // Screen page is a "big board" view; keep it stable and avoid global scaling there.
  if (isScreenPage.value) return 'default';
  return isMobile.value ? 'large' : 'default';
});

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

.app-shell {
  width: 100%;
  height: 100%;
}

.app-content {
  min-width: 0;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.page-title {
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.app-main {
  padding: 16px;
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

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 12px 16px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.drawer-menu {
  border-right: none;
}

@media (max-width: 768px) {
  .app-header {
    position: sticky;
    top: 0;
    z-index: 20;
    background: #fff;
    padding: 10px 12px;
  }

  .app-main {
    padding: 12px;
  }
}
</style>
