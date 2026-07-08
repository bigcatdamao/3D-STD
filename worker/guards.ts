// T3 防滥用守卫:Turnstile 服务端校验(D6 ①)+ 演示码解析(D6 ⑤)。

export interface TurnstileVerdict {
  ok: boolean;
  codes?: string[]; // 上游 error-codes,诊断用
}

/**
 * Turnstile siteverify(官方端点)。secret 存 Workers Secrets;
 * 上线前可先用 Cloudflare 测试 secret(接受任意 token),T12 接 widget 后换真实 key——README T3 有步骤。
 */
export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileVerdict> {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);
  let res: Response;
  try {
    res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
  } catch {
    return { ok: false, codes: ['upstream_unreachable'] };
  }
  if (!res.ok) return { ok: false, codes: [`upstream_${res.status}`] };
  const j = (await res.json()) as { success: boolean; 'error-codes'?: string[] };
  return { ok: j.success, codes: j['error-codes'] };
}

/**
 * 演示码码本:DEMO_CODES 环境变量(Secret),格式 `code` 或 `code:每日次数`,逗号分隔。
 * 撤销 = 从变量里删掉该码(dashboard 操作即生效,无需改代码)——服务层可逐码撤销(D6 ⑤)。
 */
export function parseDemoCodes(raw: string | undefined, defaultLimit: number): Map<string, number> {
  const map = new Map<string, number>();
  if (!raw) return map;
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const idx = item.indexOf(':');
    if (idx === -1) {
      map.set(item, defaultLimit);
    } else {
      const code = item.slice(0, idx).trim();
      const limit = Number(item.slice(idx + 1).trim());
      if (code) map.set(code, Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : defaultLimit);
    }
  }
  return map;
}

/** 访客复合键:客户端持久 ID + IP 的哈希(D6 ② 的 M1 简化落地,熔断层兜底绕过风险)。 */
export async function visitorKeyOf(clientId: string, ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${clientId}|${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
