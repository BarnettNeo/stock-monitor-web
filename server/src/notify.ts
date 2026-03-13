import { DingTalkNotifier, WeComAppNotifier, WeComRobotNotifier } from './notifiers';

/**
 * 订阅对象（落库 subscriptions 表后，在这里做统一抽象）。
 * - webhookUrl/keyword：用于机器人类（钉钉/企微群机器人）
 * - wecomApp：用于企业微信自建应用 API
 */
export type Subscription = {
  id: string;
  type: 'dingtalk' | 'wecom_robot' | 'wecom_app';
  enabled: boolean;
  webhookUrl?: string;
  keyword?: string;
  wecomApp?: {
    corpId: string;
    corpSecret: string;
    agentId: number;
    toUser?: string;
    toParty?: string;
    toTag?: string;
  };
};

/**
 * 推送载荷（统一使用 markdown 以便多渠道一致展示）。
 * - title：钉钉 markdown 需要标题
 * - markdown：消息正文
 */
export type NotifyPayload = {
  title: string;
  markdown: string;
};

/**
 * 根据订阅类型发送消息。
 * 返回值用于落库：记录成功/失败，便于“闭环回看”。
 */
export async function notifyBySubscription(
  sub: Subscription,
  payload: NotifyPayload,
): Promise<{ ok: boolean; error?: string }> {
  // 订阅关闭视为“无需发送”，返回 ok=true 以避免污染 trigger_logs。
  if (!sub.enabled) return { ok: true };

  try {
    if (sub.type === 'dingtalk') {
      if (!sub.webhookUrl) throw new Error('Missing webhookUrl');

      // notifier 按调用创建：配置较轻且可避免跨调用的状态干扰。
      const notifier = new DingTalkNotifier({
        webhookUrl: sub.webhookUrl,
        keyword: sub.keyword,
      });
      await notifier.sendMarkdown(payload.title, payload.markdown);
      return { ok: true };
    }

    if (sub.type === 'wecom_robot') {
      if (!sub.webhookUrl) throw new Error('Missing webhookUrl');
      const notifier = new WeComRobotNotifier({
        webhookUrl: sub.webhookUrl,
        keyword: sub.keyword,
      });
      await notifier.sendMarkdown(payload.markdown);
      return { ok: true };
    }

    if (sub.type === 'wecom_app') {
      if (!sub.wecomApp) throw new Error('Missing wecomApp config');
      const notifier = new WeComAppNotifier(sub.wecomApp);
      await notifier.sendMarkdown(payload.markdown);
      return { ok: true };
    }

    return { ok: false, error: `Unsupported type: ${(sub as any).type}` };
  } catch (e) {
    // 将异常转为可落库的字符串，便于前端触发日志详情回看。
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
