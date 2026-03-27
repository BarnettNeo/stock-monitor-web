import type { Express, Request, Response } from 'express';
import { z } from 'zod';

import { requireAuth } from '../auth';
import { getPackageInfoByUserId, validateCreateStrategyPermission } from '../package-rule';

const StrategyCheckSchema = z.object({
  enableRsiOversold: z.boolean().optional(),
  enableRsiOverbought: z.boolean().optional(),
  enableMovingAverages: z.boolean().optional(),
  enablePatternSignal: z.boolean().optional(),
});

// 注册用户套餐相关规则
export function registerPackageRoutes(app: Express): void {
  app.get('/api/users/me/package', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    try {
      const info = await getPackageInfoByUserId(user.userId);
      res.json({ item: info });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || 'failed to query package info' });
    }
  });

  app.post('/api/users/me/strategy/check', async (req: Request, res: Response) => {
    const user = await requireAuth(req, res);
    if (!user) return;

    const parsed = StrategyCheckSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ message: 'invalid request body' });
    }

    try {
      const decision = await validateCreateStrategyPermission(user, parsed.data);
      if (!decision.ok) {
        return res.status(decision.status).json({
          allowed: false,
          message: decision.message,
          package: decision.info,
        });
      }
      res.json({ allowed: true, package: decision.info });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || 'failed to validate strategy permission' });
    }
  });
}
