export interface ProviderFailure {
  status: number;
  code: string | null;
}

function safeCode(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
  return normalized || null;
}

/** 只提取状态和机器码，不记录上游正文、请求内容或 Secret。 */
export async function providerFailureOf(response: Response): Promise<ProviderFailure> {
  let code: string | null = null;
  try {
    const raw = await response.json() as Record<string, unknown>;
    const nested = raw.error && typeof raw.error === 'object' ? raw.error as Record<string, unknown> : null;
    code = safeCode(nested?.code ?? nested?.type ?? raw.code ?? raw.type ?? raw.error);
  } catch {
    // 非 JSON 错误页只保留 HTTP 状态，避免把上游正文写入日志或浏览器响应。
  }
  return { status: response.status, code };
}
