import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import express from 'express';
import cors from 'cors';
import type { Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';

import { openapiDoc } from './openapi';
import { startScheduler } from './scheduler';
import { registerAuthRoutes } from './routes/auth-routes';
import { registerStrategyRoutes } from './routes/strategies-routes';
import { registerSubscriptionRoutes } from './routes/subscriptions-routes';
import { registerTriggerLogRoutes } from './routes/trigger-logs-routes';

/**
 * server 主入口：
 * - 提供策略/订阅/触发日志的 REST API
 * - 通过内置 scheduler 周期性扫描策略：触发后推送到绑定订阅，并写入 trigger_logs
 */
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3001);

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// OpenAPI 文档：
// - /openapi.json：供 Postman/Apifox 导入
// - /api-docs：Swagger UI 可视化页面
app.get('/openapi.json', (_req: Request, res: Response) => {
  res.json(openapiDoc);
});
// 修复 TS2769 类型不匹配问题：将中间件强制转换为 any 以绕过过严格的 Express 路由类型检查
app.use('/api-docs', (swaggerUi.serve as any), (swaggerUi.setup(openapiDoc as any) as any));

registerAuthRoutes(app);
registerStrategyRoutes(app);
registerSubscriptionRoutes(app);
registerTriggerLogRoutes(app);

app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
  startScheduler().catch(err => console.error('scheduler init error:', err));
});
