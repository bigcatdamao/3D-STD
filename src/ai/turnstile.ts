// T12 · Cloudflare Turnstile widget 接线(D6 ①)。
// 设计:
//   - site key 来自构建变量 VITE_TURNSTILE_SITE_KEY(Cloudflare 构建设置里配,README T12 有步骤);
//     未配置时回退官方"永远通过"测试 site key —— 与服务侧测试 secret(1x0000…0AA)配对,
//     零账号配置即可走通全链路;换真实 key 对后,即为生产级人机验证。
//   - appearance: 'interaction-only':无感通过时 widget 不可见,仅在需要用户交互时浮现
//     (指令条寸土寸金,不常驻占位)。
//   - token 单次使用:每次 /api/generate 消费一枚;提交后调 reset() 预取下一枚。
//     过期(~300s)由 expired-callback 自动 reset。
// SSR/测试环境(无 window)全部安全空转。

const FALLBACK_TEST_SITE_KEY = '1x00000000000000000000AA'; // Cloudflare 官方测试 key:总是通过

export function turnstileSiteKey(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_TURNSTILE_SITE_KEY?.trim() || FALLBACK_TEST_SITE_KEY;
}

export const usingTestSiteKey = (): boolean => turnstileSiteKey() === FALLBACK_TEST_SITE_KEY;

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __tsOnload?: () => void;
  }
}

let scriptPromise: Promise<TurnstileApi | null> | null = null;

function loadScript(): Promise<TurnstileApi | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve) => {
    window.__tsOnload = () => resolve(window.turnstile ?? null);
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__tsOnload&render=explicit';
    s.async = true;
    s.onerror = () => resolve(null); // 脚本被墙/离线:交由上层提示,不抛错
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export interface TurnstileHandle {
  /** 当前可用 token(单次使用;取走后应 consume())。null = 验证中或失败。 */
  token: () => string | null;
  /** 消费一枚 token 并触发预取下一枚。 */
  consume: () => string | null;
  /** 强制重新验证(turnstile 类错误后调用)。 */
  reset: () => void;
  destroy: () => void;
}

/**
 * 在容器内渲染 widget。onToken 在每枚新 token 就绪时回调(用于"等待验证→自动续提交")。
 * 返回句柄;环境不支持时返回空转句柄(token 恒 null,由 UI 呈现"验证组件不可用")。
 */
export async function mountTurnstile(
  el: HTMLElement,
  onToken: (token: string) => void,
  onError?: () => void,
): Promise<TurnstileHandle> {
  const api = await loadScript();
  let current: string | null = null;
  let widgetId: string | null = null;

  if (api) {
    widgetId = api.render(el, {
      sitekey: turnstileSiteKey(),
      appearance: 'interaction-only',
      callback: (t: string) => {
        current = t;
        onToken(t);
      },
      'expired-callback': () => {
        current = null;
        if (widgetId) api.reset(widgetId);
      },
      'error-callback': () => {
        current = null;
        onError?.();
      },
    });
  }

  return {
    token: () => current,
    consume: () => {
      const t = current;
      current = null;
      if (api && widgetId) api.reset(widgetId); // 预取下一枚
      return t;
    },
    reset: () => {
      current = null;
      if (api && widgetId) api.reset(widgetId);
    },
    destroy: () => {
      if (api && widgetId) {
        try {
          api.remove(widgetId);
        } catch {
          /* widget 已随 DOM 卸载 */
        }
      }
    },
  };
}
