// 服务层骨架(T1 冒烟版):/api/health + 静态资产回退。T3 在此扩展路由。
interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, service: '3d-std worker', at: new Date().toISOString() });
    }
    return env.ASSETS.fetch(req);
  },
};
