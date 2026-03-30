<template>
  <div class="current-user-bar" :style="rootStyle">
    <div>
      {{ user?.username || '-' }}，您是{{ user?.role === 'admin' ? '管理员' : `${user?.userPackage === 'free' ? '免费用户' : '付费用户' }` }}
    </div>
    <el-button :size="buttonSize" link type="danger" @click="onLogout">退出登录</el-button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';

import { api, clearAuthToken } from '../api';

type UserInfo = {
  userId: string;
  username: string;
  role: 'admin' | 'user' | string;
  status?: string;
  userPackage?: 'free' | 'vip' | string;
};

const props = withDefaults(
  defineProps<{
    user?: UserInfo | null;
    autoFetch?: boolean;
    fontSize?: string;
    gapPx?: number;
    buttonSize?: 'default' | 'small' | 'large';
  }>(),
  {
    user: null,
    autoFetch: true,
    fontSize: '16px',
    gapPx: 16,
    buttonSize: 'default',
  },
);

const emit = defineEmits<{
  (e: 'update:user', v: UserInfo | null): void;
  (e: 'logout'): void;
}>();

const router = useRouter();

const innerUser = ref<UserInfo | null>(props.user ?? null);
watch(
  () => props.user,
  (v) => {
    innerUser.value = v ?? null;
  },
);

const user = computed(() => props.user ?? innerUser.value);


const rootStyle = computed(() => ({
  display: 'flex',
  alignItems: 'center',
  gap: `${props.gapPx}px`,
  fontSize: props.fontSize,
}));

async function fetchUserInfo(): Promise<void> {
  try {
    const res = await api.get('/auth/me');
    const u: UserInfo | null = res.data?.user || null;
    innerUser.value = u;
    emit('update:user', u);
  } catch {
    innerUser.value = null;
    emit('update:user', null);
  }
}

async function onLogout(): Promise<void> {
  try {
    await ElMessageBox.confirm('确认要退出登录吗？', '提示', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }

  clearAuthToken();
  emit('logout');
  router.replace('/login');
}

onMounted(() => {
  if (props.autoFetch) fetchUserInfo();
});
</script>

<style scoped>
.current-user-bar {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60vw;
}

@media (max-width: 768px) {
  .current-user-bar {
    max-width: 52vw;
  }
}
</style>
