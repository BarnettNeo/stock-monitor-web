import type { Express, Request, Response } from 'express';
import axios from 'axios';

import { requireAuth } from '../auth';

function getAgentsBaseUrl(): string {
  const raw = String(process.env.AGENTS_BASE_URL || 'http://127.0.0.1:8008').trim();
  return raw.replace(/\/$/, '');
}

export function registerAgentRoutes(app: Express): void {
  // Agent 网关：把请求转发给 Python agents 服务。
  // 约定：
  // - agents: POST /agent/chat
  // - gateway: POST /api/agent/chat
  app.post('/api/agent/chat', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const baseUrl = getAgentsBaseUrl();

    try {
      const r = await axios.post(
        `${baseUrl}/agent/chat`,
        {
          message: req.body?.message,
          context: req.body?.context,
          // 透传用户上下文给 agents（用于记忆/权限/个性化）
          user,
        },
        { timeout: 15000 },
      );
      res.json(r.data);
    } catch (e: any) {
      const status = Number(e?.response?.status || 503);
      const detail = e?.response?.data || null;
      const msg = e?.message || 'agents service unavailable';
      res.status(status).json({ message: 'agents 服务不可用', error: msg, detail });
    }
  });

  app.get('/api/agent/health', async (_req: Request, res: Response) => {
    const baseUrl = getAgentsBaseUrl();
    try {
      const r = await axios.get(`${baseUrl}/health`, { timeout: 5000 });
      res.json({ ok: true, upstream: r.data });
    } catch (e: any) {
      res.status(503).json({ ok: false, message: 'agents 服务不可用', error: e?.message || String(e) });
    }
  });
}
