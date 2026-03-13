import axios from 'axios';

export type WeComAppNotifierConfig = {
  corpId: string;
  corpSecret: string;
  agentId: number;
  toUser?: string;
  toParty?: string;
  toTag?: string;
};

type TokenCache = {
  accessToken: string;
  expireAtMs: number;
};

/**
 * 企业微信自建应用（应用消息）推送。
 * - 自动获取并缓存 access_token
 * - 支持 text/markdown
 */
export class WeComAppNotifier {
  private config: WeComAppNotifierConfig;
  private tokenCache: TokenCache | null = null;

  constructor(config: WeComAppNotifierConfig) {
    this.config = config;
  }

  async sendText(content: string): Promise<void> {
    await this.sendMessage({
      msgtype: 'text',
      text: { content },
    });
  }

  async sendMarkdown(content: string): Promise<void> {
    await this.sendMessage({
      msgtype: 'markdown',
      markdown: { content },
    });
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && now < this.tokenCache.expireAtMs) {
      return this.tokenCache.accessToken;
    }

    const url = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
    const resp = await axios.get(url, {
      timeout: 10000,
      params: {
        corpid: this.config.corpId,
        corpsecret: this.config.corpSecret,
      },
    });

    if (!resp.data || resp.data.errcode !== 0) {
      throw new Error(`WeCom gettoken error: ${JSON.stringify(resp.data)}`);
    }

    const accessToken = String(resp.data.access_token);
    const expiresIn = Number(resp.data.expires_in || 7200);

    // 提前 60s 过期，避免边界问题
    this.tokenCache = {
      accessToken,
      expireAtMs: now + Math.max(0, expiresIn - 60) * 1000,
    };

    return accessToken;
  }

  private async sendMessage(payload: any): Promise<void> {
    const token = await this.getAccessToken();

    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    const sendPayload = {
      touser: this.config.toUser,
      toparty: this.config.toParty,
      totag: this.config.toTag,
      msgtype: payload.msgtype,
      agentid: this.config.agentId,
      text: payload.text,
      markdown: payload.markdown,
      safe: 0,
      enable_duplicate_check: 1,
      duplicate_check_interval: 1800,
    };

    if (!sendPayload.touser && !sendPayload.toparty && !sendPayload.totag) {
      throw new Error('WeCom app notifier missing receiver: touser/toparty/totag');
    }

    const resp = await axios.post(url, sendPayload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!resp.data || resp.data.errcode !== 0) {
      throw new Error(`WeCom message/send error: ${JSON.stringify(resp.data)}`);
    }
  }
}
