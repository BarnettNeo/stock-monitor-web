import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';

import { execute, query, queryOne } from '../db';
import { requireAuth } from '../auth';
import { boolToInt, handleApiError, nowIso } from '../utils';
import { rowToSubscription } from '../mappers';
import { addClause, createWhereBuilder, normalizePagination, toWhereSql } from '../sql-utils';

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

function normalizeName(name: string): string {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

export function registerSubscriptionRoutes(app: Express): void {
  app.get('/api/subscriptions', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { page, pageSize, offset } = normalizePagination(req.query.page, req.query.pageSize, 100, 10);

    const qName = typeof req.query?.name === 'string' ? String(req.query.name).trim() : '';
    const qUsername = typeof req.query?.username === 'string' ? String(req.query.username).trim() : '';

    const where = createWhereBuilder();

    if (qName) {
      addClause(where, 's.name LIKE ?', `%${qName}%`);
    }
    if (qUsername) {
      addClause(where, 'u.username LIKE ?', `%${qUsername}%`);
    }
    const { whereSql, params } = toWhereSql(where);

    const totalRow = await queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM subscriptions s
       LEFT JOIN users u ON u.id = s.user_id
       ${whereSql}`,
      params,
    );
    const total = Number(totalRow?.cnt || 0);

    const rows = await query<any>(
      `SELECT s.*, u.username AS created_by_username
       FROM subscriptions s
       LEFT JOIN users u ON u.id = s.user_id
       ${whereSql}
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const items: any[] = rows.map((row) => ({
      ...rowToSubscription(row),
      createdByUsername: (row as any).created_by_username || (row as any).user_id || null,
    }));

    res.json({ items, page, pageSize, total });

  });

  app.get('/api/subscriptions/:id', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const row = await queryOne<any>(
      `SELECT s.*, u.username AS created_by_username
       FROM subscriptions s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?
       LIMIT 1`,
      [req.params.id],
    );
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
      const targetUserId = user.role === 'admin' ? (parsed.userId || user.userId) : user.userId;

      const name = normalizeName(parsed.name);
      if (!name) return res.status(400).json({ message: '订阅名称不能为空' });

      const dup = await queryOne<any>(
        'SELECT id FROM subscriptions WHERE user_id = ? AND name = ? LIMIT 1',
        [targetUserId, name],
      );
      if (dup) return res.status(400).json({ message: '订阅名称已存在' });

      const id = crypto.randomUUID();
      const ts = nowIso();
      await execute(
        `INSERT INTO subscriptions (
          id,user_id,name,type,enabled,webhook_url,keyword,
          wecom_app_corp_id,wecom_app_corp_secret,wecom_app_agent_id,wecom_app_to_user,wecom_app_to_party,wecom_app_to_tag,
          created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          targetUserId,
          name,
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
      const ownerRow = await queryOne<any>(
        'SELECT user_id FROM subscriptions WHERE id = ? LIMIT 1',
        [req.params.id],
      );
      if (!ownerRow) return res.status(404).json({ message: 'Not found' });
      const ownerId = (ownerRow as any).user_id ? String((ownerRow as any).user_id) : '';
      if (user.role !== 'admin' && ownerId !== user.userId) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      const targetUserId = user.role === 'admin' ? (parsed.userId || ownerId || null) : user.userId;
      if (!targetUserId) return res.status(400).json({ message: 'userId is required' });

      const name = normalizeName(parsed.name);
      if (!name) return res.status(400).json({ message: '订阅名称不能为空' });

      const dup = await queryOne<any>(
        'SELECT id FROM subscriptions WHERE user_id = ? AND name = ? AND id <> ? LIMIT 1',
        [targetUserId, name, req.params.id],
      );
      if (dup) return res.status(400).json({ message: '订阅名称已存在' });

      await execute(
        `UPDATE subscriptions SET
          user_id=?,name=?,type=?,enabled=?,webhook_url=?,keyword=?,
          wecom_app_corp_id=?,wecom_app_corp_secret=?,wecom_app_agent_id=?,wecom_app_to_user=?,wecom_app_to_party=?,wecom_app_to_tag=?,
          updated_at=?
        WHERE id=?`,
        [
          targetUserId,
          name,
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

      res.json({ ok: true });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  app.delete('/api/subscriptions/:id', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const ownerRow = await queryOne<any>(
      'SELECT user_id FROM subscriptions WHERE id = ? LIMIT 1',
      [req.params.id],
    );
    if (!ownerRow) return res.status(404).json({ message: 'Not found' });
    const ownerId = (ownerRow as any).user_id ? String((ownerRow as any).user_id) : '';
    if (user.role !== 'admin' && ownerId !== user.userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    await execute('DELETE FROM subscriptions WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });
}
