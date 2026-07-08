// 服务层入口:路由见 router.ts,配额账务见 quota-do.ts / quota-core.ts(T3)。
// wrangler 的 durable_objects 迁移要求 QuotaDO 从主模块导出。
import { handleRequest, type WorkerEnv } from './router';

export { QuotaDO } from './quota-do';

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(req, env);
  },
};
