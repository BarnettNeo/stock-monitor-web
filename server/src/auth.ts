import crypto from 'node:crypto';
import type { Request, Response } from 'express';

import { queryOne } from './db';

export type AuthedUser = {
  userId: string;
  username: string;
  role: 'admin' | 'user';
  status?: 'pending' | 'active' | 'disabled';
  userPackage?: 'free' | 'vip';
  packageExpire?: string | null;
  maxStrategyCount?: number;
};

export const AUTH_ADMIN_USER_ID = 'admin';

const AUTH_SECRET = process.env.AUTH_SECRET || 'CHANGE_ME';

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecodeToBuffer(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

export function signToken(payload: any): string {
  if (!AUTH_SECRET) {
    throw new Error('Missing AUTH_SECRET in env');
  }
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf8'));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const content = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(content).digest();
  return `${content}.${base64UrlEncode(sig)}`;
}

function verifyToken(token: string): any | null {
  try {
    if (!AUTH_SECRET) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const content = `${headerB64}.${payloadB64}`;
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(content).digest();
    const actual = base64UrlDecodeToBuffer(sigB64);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const payloadJson = base64UrlDecodeToBuffer(payloadB64).toString('utf8');
    const payload = JSON.parse(payloadJson);
    if (payload?.exp && Date.now() > Number(payload.exp) * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function pbkdf2Hash(password: string, salt: string): string {
  const buf = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  return buf.toString('hex');
}

export async function requireAuth(req: Request, res: Response): Promise<AuthedUser | null> {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Unauthorized' });
    return null;
  }
  const token = auth.slice('Bearer '.length).trim();
  const payload = verifyToken(token);
  if (!payload?.userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return null;
  }

  const row = await queryOne<any>('SELECT * FROM users WHERE id = ? LIMIT 1', [
    String(payload.userId),
  ]);
  if (!row) {
    res.status(401).json({ message: 'Unauthorized' });
    return null;
  }

  const role: 'admin' | 'user' = row.role === 'admin' ? 'admin' : 'user';
  const statusRaw = String((row as any).status || '').toLowerCase();
  const status: 'pending' | 'active' | 'disabled' =
    statusRaw === 'pending' ? 'pending' : statusRaw === 'disabled' ? 'disabled' : 'active';
  return {
    userId: String(row.id),
    username: String(row.username),
    role,
    status,
    userPackage: String((row as any).user_package || '').toLowerCase() === 'vip' ? 'vip' : 'free',
    packageExpire: (row as any).package_expire ? String((row as any).package_expire) : null,
    maxStrategyCount: Number((row as any).max_strategy_count || 0),
  };
}
