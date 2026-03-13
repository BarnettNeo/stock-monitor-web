<template>
  <el-container>
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
        <!-- <div style="opacity: .7; font-size: 12px">Phase 1 MVP</div> -->
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

const pageTitle = computed(() => {
  if (route.path.startsWith('/strategies')) return '策略管理';
  if (route.path.startsWith('/subscriptions')) return '订阅管理';
  if (route.path.startsWith('/trigger-logs')) return '触发日志';
  return 'Stock Monitor';
});
</script>
