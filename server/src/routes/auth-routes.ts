import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';

import { execute, queryOne } from '../db';
import { AUTH_ADMIN_USER_ID, pbkdf2Hash, signToken, requireAuth } from '../auth';
import { handleApiError, nowIso } from '../utils';

// 认证相关 API：注册 / 登录 / 获取当前用户
// - 用户名作为 userId（与当前系统预存 userId 字段保持一致）
// - role：admin/普通用户（admin userId 固定为 "admin"）

const RegisterSchema = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(6).max(128),
});

const LoginSchema = z.object({
  username: z.string().min(2).max(32),
  password: z.string().min(6).max(128),
});

export function registerAuthRoutes(app: Express): void {
  app.post('/api/auth/register', async (req: Request, res: Response) => {
    try {
      const parsed = RegisterSchema.parse(req.body);
      const username = parsed.username.trim();
      const userId = username;
      const role: 'admin' | 'user' = userId === AUTH_ADMIN_USER_ID ? 'admin' : 'user';
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = pbkdf2Hash(parsed.password, salt);
      const ts = nowIso();
      await execute(
        `INSERT INTO users (id,username,password_salt,password_hash,role,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
        [userId, username, salt, hash, role, ts, ts],
      );
      res.json({ ok: true });
    } catch (error: any) {
      const msg = error?.message?.includes('UNIQUE') ? '用户名已存在' : handleApiError(error).message;
      res.status(400).json({ message: msg });
    }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const parsed = LoginSchema.parse(req.body);
      const username = parsed.username.trim();
      const row = await queryOne<any>('SELECT * FROM users WHERE username = ? LIMIT 1', [
        username,
      ]);
      if (!row) return res.status(400).json({ message: '用户名或密码错误' });

      const expected = String((row as any).password_hash);
      const salt = String((row as any).password_salt);
      const actual = pbkdf2Hash(parsed.password, salt);
      if (actual !== expected) return res.status(400).json({ message: '用户名或密码错误' });

      const role: 'admin' | 'user' = (row as any).role === 'admin' ? 'admin' : 'user';
      const exp = Math.floor(Date.now() / 1000) + 3600 * 24 * 30;
      const token = signToken({ userId: String((row as any).id), role, exp });
      res.json({ token, user: { userId: String((row as any).id), username: String((row as any).username), role } });
    } catch (error: any) {
      const { status, message } = handleApiError(error);
      res.status(status).json({ message });
    }
  });

  app.get('/api/auth/me', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;
    res.json({ user });
  });
}
