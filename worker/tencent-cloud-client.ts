const API_HOST = 'ai3d.tencentcloudapi.com';
const API_SERVICE = 'ai3d';
const API_VERSION = '2025-05-13';

export interface TencentCloudClientOptions {
  secretId?: string;
  secretKey?: string;
  region?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface TencentEnvelope<T> {
  Response?: T & {
    RequestId?: string;
    Error?: { Code?: string; Message?: string };
  };
}

export class TencentCloudApiError extends Error {
  constructor(
    readonly code: string,
    readonly requestId: string | null,
    readonly httpStatus: number,
  ) {
    super(`tencent_api_error code=${code} http=${httpStatus} request=${requestId ?? 'n/a'}`);
    this.name = 'TencentCloudApiError';
  }
}
const encoder = new TextEncoder();

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? encoder.encode(value) : value;
}

function asBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(bytes(value)))));
}

async function hmac(key: string | Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    asBuffer(bytes(key)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, asBuffer(bytes(value))));
}

function utcDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

/** Workers-compatible TC3-HMAC-SHA256 client. Secrets never leave this module. */
export class TencentCloudClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TencentCloudClientOptions) {
    // Cloudflare Workers 的全局 fetch 必须保留正确的接收者。若直接保存后再以
    // `this.fetchImpl(...)` 调用，workerd 会把客户端实例作为 this，并抛出
    // `Illegal invocation: function called with incorrect 'this' reference`。
    // 注入的测试桩无需绑定；只有运行时全局 fetch 需要显式绑定 globalThis。
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  get configured(): boolean {
    return Boolean(this.options.secretId?.trim() && this.options.secretKey?.trim());
  }

  async call<T extends object>(action: string, body: object): Promise<T & { RequestId?: string }> {
    const secretId = this.options.secretId?.trim();
    const secretKey = this.options.secretKey?.trim();
    if (!secretId || !secretKey) throw new Error('tencent_credentials_missing');

    const payload = JSON.stringify(body);
    const contentType = 'application/json; charset=utf-8';
    const timestamp = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    const canonicalHeaders = `content-type:${contentType}\nhost:${API_HOST}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, await sha256(payload)].join('\n');
    const date = utcDate(timestamp);
    const credentialScope = `${date}/${API_SERVICE}/tc3_request`;
    const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, await sha256(canonicalRequest)].join('\n');
    const secretDate = await hmac(`TC3${secretKey}`, date);
    const secretService = await hmac(secretDate, API_SERVICE);
    const secretSigning = await hmac(secretService, 'tc3_request');
    const signature = hex(await hmac(secretSigning, stringToSign));
    const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await this.fetchImpl(`https://${API_HOST}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': contentType,
        Host: API_HOST,
        'X-TC-Action': action,
        'X-TC-Region': this.options.region || 'ap-guangzhou',
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': API_VERSION,
      },
      body: payload,
    });
    let envelope: TencentEnvelope<T> | null = null;
    try {
      envelope = (await response.json()) as TencentEnvelope<T>;
    } catch {
      envelope = null;
    }
    const result = envelope?.Response;
    if (!response.ok || !result || result.Error?.Code) {
      throw new TencentCloudApiError(
        result?.Error?.Code || (response.ok ? 'InvalidResponse' : `HTTP${response.status}`),
        result?.RequestId ?? null,
        response.status,
      );
    }
    return result;
  }
}
