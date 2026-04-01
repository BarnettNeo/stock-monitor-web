import { queryOne } from './db';
import type { AuthedUser } from './auth';

export type UserPackageType = 'free' | 'vip';

export type PackageInfo = {
  userId: string;
  userPackage: UserPackageType;
  packageExpire: string | null;
  packageActive: boolean;
  maxStrategyCount: number;
  strategyCount: number;
  remainStrategyCount: number;
};

export type StrategyIndicatorInput = {
  enableRsiOversold?: boolean;
  enableRsiOverbought?: boolean;
  enableMovingAverages?: boolean;
  enableVolumeSignal?: boolean;
  enablePatternSignal?: boolean;
};

const FREE_DEFAULT_MAX = 3;
const VIP_DEFAULT_MAX = 20;

function normalizeUserPackage(raw: any): UserPackageType {
  return String(raw || '').trim().toLowerCase() === 'vip' ? 'vip' : 'free';
}

function defaultMaxByPackage(pkg: UserPackageType): number {
  return pkg === 'vip' ? VIP_DEFAULT_MAX : FREE_DEFAULT_MAX;
}

function isPackageActive(expireAt: string | null): boolean {
  if (!expireAt) return true;
  const ts = Date.parse(expireAt);
  if (!Number.isFinite(ts)) return true;
  return ts >= Date.now();
}

export async function getPackageInfoByUserId(userId: string): Promise<PackageInfo> {
  const userRow = await queryOne<any>(
    'SELECT id,user_package,package_expire,max_strategy_count FROM users WHERE id = ? LIMIT 1',
    [userId],
  );
  if (!userRow) {
    throw new Error('User not found');
  }

  const strategyRow = await queryOne<any>('SELECT COUNT(*) as cnt FROM strategies WHERE user_id = ?', [userId]);
  const strategyCount = Number(strategyRow?.cnt || 0);
  const userPackage = normalizeUserPackage((userRow as any).user_package);
  const configuredMax = Number((userRow as any).max_strategy_count || 0);
  const maxStrategyCount = configuredMax > 0 ? configuredMax : defaultMaxByPackage(userPackage);
  const packageExpire = (userRow as any).package_expire ? String((userRow as any).package_expire) : null;
  const packageActive = isPackageActive(packageExpire);
  const remainStrategyCount = Math.max(0, maxStrategyCount - strategyCount);

  return {
    userId,
    userPackage,
    packageExpire,
    packageActive,
    maxStrategyCount,
    strategyCount,
    remainStrategyCount,
  };
}

export async function validateCreateStrategyPermission(
  user: AuthedUser,
  indicators: StrategyIndicatorInput = {},
): Promise<{ ok: true; info: PackageInfo } | { ok: false; status: number; message: string; info: PackageInfo }> {
  // Keep admin role unrestricted to avoid blocking system maintenance operations.
  if (user.role === 'admin') {
    const info = await getPackageInfoByUserId(user.userId);
    return { ok: true, info };
  }

  const info = await getPackageInfoByUserId(user.userId);

  if (!info.packageActive) {
    return { ok: false, status: 403, message: '套餐已过期，请续费后再创建策略。', info };
  }

  if (info.strategyCount >= info.maxStrategyCount) {
    return {
      ok: false,
      status: 403,
      message: `当前套餐最多创建 ${info.maxStrategyCount} 个策略，已达上限。`,
      info,
    };
  }

  if (info.userPackage === 'free') {
    const blocked =
      Boolean(indicators.enableRsiOversold) ||
      Boolean(indicators.enableRsiOverbought) ||
      Boolean(indicators.enableMovingAverages) ||
      Boolean(indicators.enableVolumeSignal) ||
      Boolean(indicators.enablePatternSignal);
    if (blocked) {
      return {
        ok: false,
        status: 403,
        message: '免费版不支持 RSI 超卖/RSI 超买/均线信号/成交量信号/形态信号，请升级套餐后使用。',
        info,
      };
    }
  }

  return { ok: true, info };
}
