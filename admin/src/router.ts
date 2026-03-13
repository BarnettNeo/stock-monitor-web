import { createRouter, createWebHistory } from 'vue-router';

import StrategiesPage from './views/StrategiesPage.vue';
import SubscriptionsPage from './views/SubscriptionsPage.vue';
import TriggerLogsPage from './views/TriggerLogsPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/strategies' },
    { path: '/strategies', component: StrategiesPage },
    { path: '/subscriptions', component: SubscriptionsPage },
    { path: '/trigger-logs', component: TriggerLogsPage },
  ],
});
