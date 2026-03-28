import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';

import { execute, queryOne } from '../db';
import { AUTH_ADMIN_USER_ID, pbkdf2Hash, signToken, requireAuth } from '../auth';
import { handleApiError, nowIso } from '../utils';

// 认证相关 API：注册 / 登录 / 获取当前用户
// - 用户名作为 userId（与当前系统预存 userId 字段保持一致）
// - role：admin/普通用户（admin userId 固定为 "admin"）

const PasswordSchema = z
  .string()
  .min(6, { message: '密码长度需要 6-20 位' })
  .max(20, { message: '密码长度需要 6-20 位' })
  .refine((v) => !/\s/.test(v), { message: '密码不能包含空格' });

const RegisterSchema = z.object({
  username: z.string().min(2).max(32),
  password: PasswordSchema,
});

type CaptchaRecord = { codeLower: string; expiresAt: number };
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const captchaStore = new Map<string, CaptchaRecord>();

function cleanupCaptchaStore(): void {
  const now = Date.now();
  for (const [id, rec] of captchaStore.entries()) {
    if (rec.expiresAt <= now) captchaStore.delete(id);
  }
}

function generateCaptchaText(len = 4): string {
  // Avoid ambiguous chars like 0/O, 1/I.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

function renderCaptchaSvg(text: string): string {
  const w = 120;
  const h = 40;
  const bg = '#f5f7fa';
  const stroke = '#c0c4cc';
  const noiseColor = '#909399';

  const lines: string[] = [];
  for (let i = 0; i < 4; i++) {
    const x1 = crypto.randomInt(0, w);
    const y1 = crypto.randomInt(0, h);
    const x2 = crypto.randomInt(0, w);
    const y2 = crypto.randomInt(0, h);
    lines.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${noiseColor}" stroke-width="1" opacity="0.6" />`,
    );
  }

  const chars: string[] = [];
  const per = w / (text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const x = Math.round(per * (i + 1));
    const y = crypto.randomInt(24, 34);
    const rot = crypto.randomInt(-18, 19);
    const fill = '#303133';
    chars.push(
      `<text x="${x}" y="${y}" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="${fill}" transform="rotate(${rot} ${x} ${y})">${text[i]}</text>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="8" ry="8" fill="${bg}" stroke="${stroke}" />
  ${lines.join('\n  ')}
  ${chars.join('\n  ')}
</svg>`;
}

const LoginSchema = z.object({
  username: z.string().min(2).max(32),
  password: PasswordSchema,
  captchaId: z.string().min(8),
  captchaCode: z.string().min(3).max(16),
});

function verifyCaptcha(captchaId: string, captchaCode: string): boolean {
  cleanupCaptchaStore();
  const rec = captchaStore.get(captchaId);
  if (!rec) return false;
  const ok =
    rec.expiresAt > Date.now() &&
    rec.codeLower === String(captchaCode || '').trim().toLowerCase();
  // One-time use regardless of success to reduce brute-force retries.
  captchaStore.delete(captchaId);
  return ok;
}

export function registerAuthRoutes(app: Express): void {
  app.get('/api/auth/captcha', async (_req: Request, res: Response) => {
    cleanupCaptchaStore();
    const captchaId = crypto.randomUUID();
    const text = generateCaptchaText(4);
    const svg = renderCaptchaSvg(text);
    captchaStore.set(captchaId, { codeLower: text.toLowerCase(), expiresAt: Date.now() + CAPTCHA_TTL_MS });
    const image = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    res.json({ captchaId, image, expiresInSeconds: Math.floor(CAPTCHA_TTL_MS / 1000) });
  });

  app.post('/api/auth/register', async (req: Request, res: Response) => {
    try {
      const parsed = RegisterSchema.parse(req.body);
      const username = parsed.username.trim();
      const userId = username;
      const role: 'admin' | 'user' = userId === AUTH_ADMIN_USER_ID ? 'admin' : 'user';
      const userPackage: 'free' | 'vip' = role === 'admin' ? 'vip' : 'free';
      const maxStrategyCount = role === 'admin' ? 9999 : 3;
      const status: 'active' | 'pending' = role === 'admin' ? 'active' : 'pending';
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = pbkdf2Hash(parsed.password, salt);
      const ts = nowIso();
      const expire = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
      await execute(
        `INSERT INTO users (id,username,password_salt,password_hash,role,status,user_package,package_expire,max_strategy_count,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [userId, username, salt, hash, role, status, userPackage, expire, maxStrategyCount, ts, ts],
      );
      res.json({ ok: true });
    } catch (error: any) {
      if (error?.message?.includes('UNIQUE')) {
        return res.status(400).json({ message: '用户名已存在' });
      }
      const msg = error?.message?.includes('UNIQUE') ? '用户名已存在' : handleApiError(error).message;
      res.status(400).json({ message: msg });
    }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const parsed = LoginSchema.parse(req.body);
      const captchaOk = verifyCaptcha(parsed.captchaId, parsed.captchaCode);
      if (!captchaOk) {
        return res.status(400).json({ message: '验证码错误或已过期' });
      }
      const username = parsed.username.trim();
      const row = await queryOne<any>('SELECT * FROM users WHERE username = ? LIMIT 1', [
        username,
      ]);
      if (!row) return res.status(400).json({ message: '用户名或密码错误' });

      const statusRaw = String((row as any).status || '').toLowerCase();
      const status: 'pending' | 'active' | 'disabled' =
        statusRaw === 'pending' ? 'pending' : statusRaw === 'disabled' ? 'disabled' : 'active';
      if (status === 'pending') {
        return res.status(403).json({ message: '当前用户待管理员审核中' });
      }
      if (status === 'disabled') {
        return res.status(403).json({ message: '账号已禁用' });
      }
      if (!row) return res.status(400).json({ message: '用户名或密码错误' });

      const expected = String((row as any).password_hash);
      const salt = String((row as any).password_salt);
      const actual = pbkdf2Hash(parsed.password, salt);
      if (actual !== expected) return res.status(400).json({ message: '用户名或密码错误' });

      const role: 'admin' | 'user' = (row as any).role === 'admin' ? 'admin' : 'user';
      const exp = Math.floor(Date.now() / 1000) + 3600 * 24 * 30;
      const token = signToken({ userId: String((row as any).id), role, exp });
      res.json({
        token,
        user: {
          userId: String((row as any).id),
          username: String((row as any).username),
          role,
          status,
          userPackage: (row as any).user_package || 'free',
          packageExpire: (row as any).package_expire || null,
          maxStrategyCount: Number((row as any).max_strategy_count || 0),
        },
      });
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
