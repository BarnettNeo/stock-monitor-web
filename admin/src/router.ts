import { createRouter, createWebHistory } from 'vue-router';

import { getAuthToken } from './api';

import LoginPage from './views/LoginPage.vue';
import RegisterPage from './views/RegisterPage.vue';
import StrategiesPage from './views/StrategiesPage.vue';
import SubscriptionsPage from './views/SubscriptionsPage.vue';
import TriggerLogsPage from './views/TriggerLogsPage.vue';
import TriggerLogDetailPage from './views/TriggerLogDetailPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/strategies' },
    { path: '/login', component: LoginPage, meta: { public: true } },
    { path: '/register', component: RegisterPage, meta: { public: true } },
    { path: '/strategies', component: StrategiesPage },
    { path: '/subscriptions', component: SubscriptionsPage },
    { path: '/trigger-logs', component: TriggerLogsPage },
    { path: '/trigger-logs/:id', component: TriggerLogDetailPage },
  ],
});

router.beforeEach((to) => {
  const isPublic = Boolean((to.meta as any)?.public);
  if (isPublic) return true;
  const token = getAuthToken();
  if (!token) {
    return { path: '/login' };
  }
  return true;
});
