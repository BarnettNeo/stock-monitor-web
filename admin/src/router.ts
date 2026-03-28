import { createRouter, createWebHistory } from 'vue-router';

import { api, getAuthToken } from './api';

import LoginPage from './views/LoginPage.vue';
import RegisterPage from './views/RegisterPage.vue';
import StrategiesPage from './views/StrategiesPage.vue';
import SubscriptionsPage from './views/SubscriptionsPage.vue';
import TriggerLogsPage from './views/TriggerLogsPage.vue';
import TriggerLogDetailPage from './views/TriggerLogDetailPage.vue';
import ScreenHomePage from './views/ScreenHomePage.vue';
import ProfilePackagePage from './views/ProfilePackagePage.vue';
import UserManagementPage from './views/UserManagementPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/screen' },
    { path: '/login', component: LoginPage, meta: { public: true } },
    { path: '/register', component: RegisterPage, meta: { public: true } },
    { path: '/screen', component: ScreenHomePage },
    { path: '/strategies', component: StrategiesPage },
    { path: '/subscriptions', component: SubscriptionsPage },
    { path: '/profile/package', component: ProfilePackagePage },
    { path: '/users', component: UserManagementPage, meta: { admin: true } },
    { path: '/trigger-logs', component: TriggerLogsPage },
    { path: '/trigger-logs/:id', component: TriggerLogDetailPage },
  ],
});

router.beforeEach(async (to) => {
  const isPublic = Boolean((to.meta as any)?.public);
  if (isPublic) return true;
  const token = getAuthToken();
  if (!token) {
    return { path: '/login' };
  }
  const adminOnly = Boolean((to.meta as any)?.admin);
  if (adminOnly) {
    try {
      const res = await api.get('/auth/me');
      const role = res.data?.user?.role;
      if (role !== 'admin') {
        return { path: '/screen' };
      }
    } catch {
      return { path: '/login' };
    }
  }
  return true;
});
