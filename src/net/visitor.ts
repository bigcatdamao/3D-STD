// T3 前端配套:访客标识 + 演示码捕获。
// 服务层的访客复合键 = 本 clientId + IP 的哈希(worker/guards.ts);
// clientId 持久于 localStorage(隐私模式下退化为会话级,熔断层兜底)。
// 演示码:URL ?demo=xxx 捕获后存 sessionStorage(链接分享语义:本次会话有效),随请求头上行。
// T12 的生成请求同样经 apiHeaders() 组装,勿另起炉灶。

const CLIENT_KEY = '3dstd:client-id';
const DEMO_KEY = '3dstd:demo-code';

let ephemeralId: string | null = null; // 无 storage 环境(SSR/测试/被禁)的会话级回退

const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function getClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_KEY);
    if (existing) return existing;
    const id = uuid();
    localStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    if (!ephemeralId) ephemeralId = uuid();
    return ephemeralId;
  }
}

/** 页面装载时调用一次:把 URL 上的 ?demo= 收进会话存储(之后刷新/内部跳转不丢)。 */
export function captureDemoCode(search?: string): string | null {
  try {
    const qs = search ?? (typeof location !== 'undefined' ? location.search : '');
    const fromUrl = new URLSearchParams(qs).get('demo')?.trim();
    if (fromUrl) {
      sessionStorage.setItem(DEMO_KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(DEMO_KEY);
  } catch {
    return null;
  }
}

export function getDemoCode(): string | null {
  try {
    return sessionStorage.getItem(DEMO_KEY);
  } catch {
    return null;
  }
}

/** 服务层请求头(/api/quota、/api/generate 等统一使用)。 */
export function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'x-client-id': getClientId() };
  const demo = getDemoCode();
  if (demo) h['x-demo-code'] = demo;
  return h;
}
