import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';

import { execute, query, queryOne } from '../db';
import { AUTH_ADMIN_USER_ID, pbkdf2Hash, requireAuth } from '../auth';
import { handleApiError, nowIso } from '../utils';
import { addClause, createWhereBuilder, toWhereSql } from '../sql-utils';

const PasswordSchema = z
  .string()
  .min(6, { message: '密码长度需要 6-20 位' })
  .max(20, { message: '密码长度需要 6-20 位' })
  .refine((v) => !/\s/.test(v), { message: '密码不能包含空格' });

const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: PasswordSchema,
});

const AdminCreateUserSchema = z.object({
  username: z.string().min(2).max(32),
  password: PasswordSchema,
  role: z.enum(['admin', 'user']).optional().default('user'),
  status: z.enum(['pending', 'active', 'disabled']).optional().default('active'),
  userPackage: z.enum(['free', 'vip']).optional().default('free'),
  packageExpire: z.string().nullable().optional(),
  maxStrategyCount: z.number().int().min(1).max(9999).optional(),
});

const AdminUpdateUserSchema = z.object({
  password: PasswordSchema.optional(),
  status: z.enum(['pending', 'active', 'disabled']).optional(),
  userPackage: z.enum(['free', 'vip']).optional(),
  packageExpire: z.string().nullable().optional(),
  maxStrategyCount: z.number().int().min(1).max(9999).optional(),
});

function requireAdmin(user: { role: string } | null, res: Response): user is { role: 'admin' } {
  if (!user) return false;
  if (user.role !== 'admin') {
    res.status(403).json({ message: 'Forbidden' });
    return false;
  }
  return true;
}

export function registerUserRoutes(app: Express): void {
  // 个人中心: 修改密码
  app.put('/api/users/me/password', async (req: Request, res: Response) => {
    try {
      const user = await requireAuth(req, res);
      if (!user) return;

      const parsed = ChangePasswordSchema.parse(req.body || {});
      const row = await queryOne<any>('SELECT * FROM users WHERE id = ? LIMIT 1', [user.userId]);
      if (!row) return res.status(404).json({ message: 'Not found' });

      const expected = String((row as any).password_hash);
      const salt = String((row as any).password_salt);
      const actual = pbkdf2Hash(parsed.oldPassword, salt);
      if (actual !== expected) {
        return res.status(400).json({ message: '原密码不正确' });
      }

      const newSalt = crypto.randomBytes(16).toString('hex');
      const newHash = pbkdf2Hash(parsed.newPassword, newSalt);
      const ts = nowIso();
      await execute(
        'UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?',
        [newSalt, newHash, ts, user.userId],
      );
      res.json({ ok: true });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  // 管理员: 用户管理 CRUD + 搜索
  app.get('/api/users', async (req: Request, res: Response) => {
    try {
      const user = await requireAuth(req, res);
      if (!requireAdmin(user, res)) return;

      const qUsername = typeof req.query?.username === 'string' ? String(req.query.username).trim() : '';
      const qPassword = typeof req.query?.password === 'string' ? String(req.query.password).trim() : '';
      const qPackage = typeof req.query?.packageType === 'string' ? String(req.query.packageType).trim() : '';
      const qStatus = typeof req.query?.status === 'string' ? String(req.query.status).trim() : '';
      const qExpireFrom = typeof req.query?.expireFrom === 'string' ? String(req.query.expireFrom).trim() : '';
      const qExpireTo = typeof req.query?.expireTo === 'string' ? String(req.query.expireTo).trim() : '';

      const where = createWhereBuilder();
      if (qUsername) addClause(where, 'username LIKE ?', `%${qUsername}%`);
      if (qPassword) addClause(where, 'password_hash LIKE ?', `%${qPassword}%`);
      if (qPackage) addClause(where, 'user_package = ?', qPackage);
      if (qStatus) addClause(where, 'status = ?', qStatus);
      if (qExpireFrom) addClause(where, 'package_expire >= ?', qExpireFrom);
      if (qExpireTo) addClause(where, 'package_expire <= ?', qExpireTo);
      const { whereSql, params } = toWhereSql(where);

      const rows = await query<any>(
        `SELECT id,username,password_hash,role,status,user_package,package_expire,max_strategy_count,created_at,updated_at
         FROM users
         ${whereSql}
         ORDER BY updated_at DESC`,
        params,
      );

      res.json({
        items: rows.map((r) => ({
          userId: String((r as any).id),
          username: String((r as any).username),
          passwordHash: String((r as any).password_hash || ''),
          role: String((r as any).role || 'user'),
          status: String((r as any).status || 'active'),
          userPackage: String((r as any).user_package || 'free'),
          packageExpire: (r as any).package_expire ? String((r as any).package_expire) : null,
          maxStrategyCount: Number((r as any).max_strategy_count || 0),
          createdAt: String((r as any).created_at || ''),
          updatedAt: String((r as any).updated_at || ''),
        })),
      });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  app.post('/api/users', async (req: Request, res: Response) => {
    try {
      const user = await requireAuth(req, res);
      if (!requireAdmin(user, res)) return;

      const parsed = AdminCreateUserSchema.parse(req.body || {});
      const username = parsed.username.trim();
      const userId = username;

      if (userId === AUTH_ADMIN_USER_ID && parsed.role !== 'admin') {
        return res.status(400).json({ message: 'admin 账号不能被创建为普通用户' });
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = pbkdf2Hash(parsed.password, salt);
      const ts = nowIso();
      await execute(
        `INSERT INTO users (id,username,password_salt,password_hash,role,status,user_package,package_expire,max_strategy_count,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          userId,
          username,
          salt,
          hash,
          parsed.role,
          parsed.status,
          parsed.userPackage,
          parsed.packageExpire ?? null,
          parsed.maxStrategyCount ?? (parsed.role === 'admin' ? 9999 : 3),
          ts,
          ts,
        ],
      );

      res.json({ ok: true, id: userId });
    } catch (error: any) {
      // Keep the same user-friendly message for duplicates.
      if (error?.message?.includes('UNIQUE')) {
        return res.status(400).json({ message: '用户名已存在' });
      }
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  app.put('/api/users/:id', async (req: Request, res: Response) => {
    try {
      const user = await requireAuth(req, res);
      if (!requireAdmin(user, res)) return;

      const targetId = String(req.params.id || '').trim();
      if (!targetId) return res.status(400).json({ message: 'invalid id' });
      // if (targetId === AUTH_ADMIN_USER_ID) {
      //   return res.status(400).json({ message: 'admin 账号不允许在这里修改' });
      // }

      const parsed = AdminUpdateUserSchema.parse(req.body || {});
      const row = await queryOne<any>('SELECT id FROM users WHERE id = ? LIMIT 1', [targetId]);
      if (!row) return res.status(404).json({ message: 'Not found' });

      const ts = nowIso();
      let salt: string | null = null;
      let hash: string | null = null;
      if (parsed.password) {
        salt = crypto.randomBytes(16).toString('hex');
        hash = pbkdf2Hash(parsed.password, salt);
      }

      await execute(
        `UPDATE users SET
          ${salt ? 'password_salt=?,password_hash=?,' : ''}
          ${parsed.status ? 'status=?,' : ''}
          ${parsed.userPackage ? 'user_package=?,' : ''}
          ${typeof parsed.packageExpire !== 'undefined' ? 'package_expire=?,' : ''}
          ${typeof parsed.maxStrategyCount !== 'undefined' ? 'max_strategy_count=?,' : ''}
          updated_at=?
        WHERE id=?`,
        [
          ...(salt ? [salt, hash] : []),
          ...(parsed.status ? [parsed.status] : []),
          ...(parsed.userPackage ? [parsed.userPackage] : []),
          ...(typeof parsed.packageExpire !== 'undefined' ? [parsed.packageExpire] : []),
          ...(typeof parsed.maxStrategyCount !== 'undefined' ? [parsed.maxStrategyCount] : []),
          ts,
          targetId,
        ],
      );

      res.json({ ok: true });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  app.delete('/api/users/:id', async (req: Request, res: Response) => {
    try {
      const user = await requireAuth(req, res);
      if (!requireAdmin(user, res)) return;

      const targetId = String(req.params.id || '').trim();
      if (!targetId) return res.status(400).json({ message: 'invalid id' });
      if (targetId === AUTH_ADMIN_USER_ID) {
        return res.status(400).json({ message: 'admin 账号不允许删除' });
      }

      await execute('DELETE FROM trigger_logs WHERE user_id = ?', [targetId]);
      await execute('DELETE FROM strategies WHERE user_id = ?', [targetId]);
      await execute('DELETE FROM subscriptions WHERE user_id = ?', [targetId]);
      await execute('DELETE FROM users WHERE id = ?', [targetId]);

      res.json({ ok: true });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });
}

