export const HI3D_BASE = 'https://api.hitem3d.ai/open-api/v1';
export const HI3D_TOKEN_ENDPOINT = `${HI3D_BASE}/auth/token`;

export interface Hi3DEnvelope<T> {
  code: number | string;
  data?: T;
  msg?: string;
  message?: string;
}

interface Hi3DTokenData {
  accessToken: string;
  tokenType?: string;
  nonce?: string;
}

interface CachedToken {
  token: string;
  type: string;
  expiresAt: number;
}

export interface Hi3DClientOptions {
  accessKey?: string;
  secretKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  tokenTtlMs?: number;
}

const tokenCache = new Map<string, CachedToken>();

export function clearHi3DTokenCache(): void {
  tokenCache.clear();
}

export function hi3dCodeOk(code: number | string | undefined): boolean {
  return code === 200 || code === '200';
}

function basicCredentials(accessKey: string, secretKey: string): string {
  const bytes = new TextEncoder().encode(`${accessKey}:${secretKey}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Hi3D API transport shared by image-to-3D and semantic segmentation.
 * AK/SK only exist inside the Worker. The browser receives neither credentials nor access tokens.
 */
export class Hi3DClient {
  constructor(private readonly options: Hi3DClientOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch.bind(globalThis);
  }

  private credentials(): { accessKey: string; secretKey: string } {
    const accessKey = this.options.accessKey?.trim();
    const secretKey = this.options.secretKey?.trim();
    if (!accessKey || !secretKey) throw new Error('hi3d_credentials_missing');
    return { accessKey, secretKey };
  }

  private async token(forceRefresh = false): Promise<CachedToken> {
    const { accessKey, secretKey } = this.credentials();
    const now = (this.options.now ?? Date.now)();
    const cached = tokenCache.get(accessKey);
    if (!forceRefresh && cached && cached.expiresAt > now) return cached;

    const response = await this.fetchImpl(HI3D_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basicCredentials(accessKey, secretKey)}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });
    let body: Hi3DEnvelope<Hi3DTokenData> | null = null;
    try {
      body = (await response.json()) as Hi3DEnvelope<Hi3DTokenData>;
    } catch {
      body = null;
    }
    const accessToken = body?.data?.accessToken?.trim();
    if (!response.ok || !body || !hi3dCodeOk(body.code) || !accessToken) {
      throw new Error(`hi3d_auth_failed http=${response.status} code=${body?.code ?? 'n/a'}`);
    }

    const token: CachedToken = {
      token: accessToken,
      type: body.data?.tokenType?.trim() || 'Bearer',
      // The public response does not document an expiry field. Keep the cache deliberately short.
      expiresAt: now + (this.options.tokenTtlMs ?? 50 * 60 * 1000),
    };
    tokenCache.set(accessKey, token);
    return token;
  }

  async authorizedFetch(input: string, init: RequestInit = {}, authorizationType?: 'Bearer' | 'Token'): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(attempt > 0);
      const headers = new Headers(init.headers);
      headers.set('authorization', `${authorizationType ?? token.type} ${token.token}`);
      headers.set('accept', 'application/json');
      const response = await this.fetchImpl(input, { ...init, headers });
      if ((response.status === 401 || response.status === 403) && attempt === 0) continue;
      return response;
    }
    throw new Error('hi3d_auth_retry_exhausted');
  }

  /**
   * Send a non-replayable streaming request exactly once.
   *
   * Large split meshes are forwarded from the browser to Hi3D without first
   * buffering the multipart body inside the Worker. A consumed request stream
   * cannot be retried after a 401/403, so invalidate the cached token and let
   * the caller refund the task; the next explicit user retry obtains a fresh
   * token.
   */
  async authorizedFetchStream(
    input: string,
    init: RequestInit,
    authorizationType?: 'Bearer' | 'Token',
  ): Promise<Response> {
    const token = await this.token();
    const headers = new Headers(init.headers);
    headers.set('authorization', `${authorizationType ?? token.type} ${token.token}`);
    headers.set('accept', 'application/json');
    const response = await this.fetchImpl(input, { ...init, headers });
    if (response.status === 401 || response.status === 403) {
      const accessKey = this.options.accessKey?.trim();
      if (accessKey) tokenCache.delete(accessKey);
    }
    return response;
  }
}
