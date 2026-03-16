import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';

import { getDb, persist } from '../db';
import { requireAuth } from '../auth';
import { boolToInt, handleApiError, nowIso } from '../utils';
import { rowToSubscription } from '../mappers';

// 订阅管理 API
// - 列表支持 name/username 模糊查询
// - 返回 createdByUsername（创建人用户名）
// - 普通用户可查看全部，但只能编辑/删除自己创建的；管理员全权限

const SubscriptionInputSchema = z.object({
  userId: z.string().nullable().optional(),
  name: z.string().min(1),
  type: z.enum(['dingtalk', 'wecom_robot', 'wecom_app']),
  enabled: z.boolean().default(true),
  webhookUrl: z.string().url().optional(),
  keyword: z.string().optional(),
  wecomApp: z
    .object({
      corpId: z.string().min(1),
      corpSecret: z.string().min(1),
      agentId: z.number().int().positive(),
      toUser: z.string().optional(),
      toParty: z.string().optional(),
      toTag: z.string().optional(),
    })
    .optional(),
});

export function registerSubscriptionRoutes(app: Express): void {
  app.get('/api/subscriptions', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const qName = typeof req.query?.name === 'string' ? String(req.query.name).trim() : '';
    const qUsername = typeof req.query?.username === 'string' ? String(req.query.username).trim() : '';

    const db = await getDb();

    const where: string[] = [];
    const params: any[] = [];
    if (qName) {
      where.push('s.name LIKE ?');
      params.push(`%${qName}%`);
    }
    if (qUsername) {
      where.push('u.username LIKE ?');
      params.push(`%${qUsername}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const stmt = db.prepare(
      `SELECT s.*, u.username AS created_by_username
       FROM subscriptions s
       LEFT JOIN users u ON u.id = s.user_id
       ${whereSql}
       ORDER BY s.updated_at DESC`,
    );
    stmt.bind(params);
    const items: any[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      items.push({
        ...rowToSubscription(row),
        createdByUsername: (row as any).created_by_username || (row as any).user_id || null,
      });
    }
    stmt.free();

    res.json({ items });
  });

  app.get('/api/subscriptions/:id', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const db = await getDb();
    const stmt = db.prepare(
      `SELECT s.*, u.username AS created_by_username
       FROM subscriptions s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    );
    stmt.bind([req.params.id]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    if (!row) return res.status(404).json({ error: 'Not found' });

    res.json({
      item: {
        ...rowToSubscription(row),
        createdByUsername: (row as any).created_by_username || (row as any).user_id || null,
      },
    });
  });

  app.post('/api/subscriptions', async (req: Request, res: Response) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;

      const parsed = SubscriptionInputSchema.parse(req.body);
      const id = crypto.randomUUID();
      const ts = nowIso();
      const db = await getDb();

      db.run(
        `INSERT INTO subscriptions (
          id,user_id,name,type,enabled,webhook_url,keyword,
          wecom_app_corp_id,wecom_app_corp_secret,wecom_app_agent_id,wecom_app_to_user,wecom_app_to_party,wecom_app_to_tag,
          created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          user.userId,
          parsed.name,
          parsed.type,
          boolToInt(parsed.enabled),
          parsed.webhookUrl || null,
          parsed.keyword || null,
          parsed.wecomApp?.corpId || null,
          parsed.wecomApp?.corpSecret || null,
          parsed.wecomApp?.agentId || null,
          parsed.wecomApp?.toUser || null,
          parsed.wecomApp?.toParty || null,
          parsed.wecomApp?.toTag || null,
          ts,
          ts,
        ],
      );

      persist();
      res.json({ id });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  app.put('/api/subscriptions/:id', async (req: Request, res: Response) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;

      const parsed = SubscriptionInputSchema.parse(req.body);
      const ts = nowIso();
      const db = await getDb();

      const stmtOwner = db.prepare('SELECT user_id FROM subscriptions WHERE id = ?');
      stmtOwner.bind([req.params.id]);
      const ownerRow = stmtOwner.step() ? stmtOwner.getAsObject() : null;
      stmtOwner.free();
      if (!ownerRow) return res.status(404).json({ message: 'Not found' });
      const ownerId = (ownerRow as any).user_id ? String((ownerRow as any).user_id) : '';
      if (user.role !== 'admin' && ownerId !== user.userId) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      db.run(
        `UPDATE subscriptions SET
          user_id=?,name=?,type=?,enabled=?,webhook_url=?,keyword=?,
          wecom_app_corp_id=?,wecom_app_corp_secret=?,wecom_app_agent_id=?,wecom_app_to_user=?,wecom_app_to_party=?,wecom_app_to_tag=?,
          updated_at=?
        WHERE id=?`,
        [
          user.role === 'admin' ? parsed.userId || ownerId || null : user.userId,
          parsed.name,
          parsed.type,
          boolToInt(parsed.enabled),
          parsed.webhookUrl || null,
          parsed.keyword || null,
          parsed.wecomApp?.corpId || null,
          parsed.wecomApp?.corpSecret || null,
          parsed.wecomApp?.agentId || null,
          parsed.wecomApp?.toUser || null,
          parsed.wecomApp?.toParty || null,
          parsed.wecomApp?.toTag || null,
          ts,
          req.params.id,
        ],
      );

      persist();
      res.json({ ok: true });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  app.delete('/api/subscriptions/:id', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const db = await getDb();

    const stmtOwner = db.prepare('SELECT user_id FROM subscriptions WHERE id = ?');
    stmtOwner.bind([req.params.id]);
    const ownerRow = stmtOwner.step() ? stmtOwner.getAsObject() : null;
    stmtOwner.free();
    if (!ownerRow) return res.status(404).json({ message: 'Not found' });
    const ownerId = (ownerRow as any).user_id ? String((ownerRow as any).user_id) : '';
    if (user.role !== 'admin' && ownerId !== user.userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    db.run('DELETE FROM subscriptions WHERE id = ?', [req.params.id]);
    persist();
    res.json({ ok: true });
  });
}
