import type { NotifyPayload, Subscription } from './notify';

import { buildDingTalkPayload, buildWeComPayload } from './notifiers';

function appendAttribution(payload: NotifyPayload, ev: any): NotifyPayload {
  const attribution = ev?.attribution;
  const summary = attribution?.summary ? String(attribution.summary).trim() : '';
  if (!summary) return payload;

  const followUps: string[] = Array.isArray(attribution.followUps)
    ? attribution.followUps.map((s: any) => String(s).trim()).filter(Boolean)
    : [];

  const citations: any[] = Array.isArray(attribution.citations) ? attribution.citations : [];

  const lines: string[] = [];
  lines.push('');
  lines.push('---');
  lines.push('### 原因分析');
  lines.push(summary);

  if (followUps.length > 0) {
    lines.push('');
    lines.push('### 后续关注');
    for (const x of followUps.slice(0, 5)) {
      lines.push(`- ${x}`);
    }
  }

  if (citations.length > 0) {
    lines.push('');
    lines.push('### 相关资讯(近10分钟)');
    let i = 1;
    for (const c of citations.slice(0, 5)) {
      const title = String(c?.title || '').trim();
      if (!title) continue;
      const src = c?.source ? String(c.source) : '';
      const ts = c?.publishedAt ? String(c.publishedAt) : '';
      const url = c?.url ? String(c.url) : '';
      const meta = [src, ts].filter(Boolean).join(' ');
      lines.push(`${i}. ${title}${meta ? ` (${meta})` : ''}${url ? ` ${url}` : ''}`);
      i++;
    }
  }

  return { ...payload, markdown: `${payload.markdown}${lines.join('\n')}` };
}

// 根据事件和渠道构建统一的通知载荷
export function buildNotifyPayload(ev: any, channel: Subscription['type']): NotifyPayload {
  const base = channel === 'dingtalk' ? buildDingTalkPayload(ev) : buildWeComPayload(ev);
  return appendAttribution(base, ev);
}
