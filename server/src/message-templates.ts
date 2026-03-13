import type { NotifyPayload, Subscription } from './notify';

import { buildDingTalkPayload, buildWeComPayload } from './notifiers';

// 根据事件和通道构建统一的通知载荷
export function buildNotifyPayload(ev: any, channel: Subscription['type']): NotifyPayload {
  if (channel === 'dingtalk') {
    return buildDingTalkPayload(ev);
  }

  return buildWeComPayload(ev);
}


