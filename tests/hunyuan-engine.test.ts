import { describe, expect, it } from 'vitest';
import type { CancelResponse, GenerateResponse, HealthResponse, SplitResultManifestResponse, SplitSubmitResponse } from '../worker/api-types';
import { HunyuanEngine } from '../worker/hunyuan-engine';
import { QuotaDO, type DurableState } from '../worker/quota-do';
import { handleRequest, type WorkerEnv } from '../worker/router';

function taskMap() {
  const values = new Map<string, string>();
  return {
    put: async (engineId: string, billingId: string) => void values.set(engineId, billingId),
    get: async (engineId: string) => values.get(engineId) ?? null,
  };
}

function apiResponse(body: object) {
  return Response.json({ Response: body });
}

describe('M1.17a Hunyuan provider', () => {
  it('binds the default Worker fetch to globalThis instead of the Tencent client instance', async () => {
    const originalFetch = globalThis.fetch;
    let seenThis: unknown = 'unset';
    globalThis.fetch = function (this: unknown) {
      seenThis = this;
      return Promise.resolve(apiResponse({ JobId: 'g-this', RequestId: 'r-this' }));
    } as unknown as typeof fetch;

    try {
      const engine = new HunyuanEngine({
        secretId: 'secret-id',
        secretKey: 'secret-key',
        now: () => Date.UTC(2026, 7, 3),
        taskMap: taskMap(),
      });

      await expect(engine.submit({ type: 'text', prompt: 'worker fetch binding' }, 'bill-this'))
        .resolves.toMatchObject({ taskId: 'hy3d_g-this', requestId: 'r-this' });
      expect(seenThis === undefined || seenThis === globalThis).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('signs a Geometry+FBX request and exposes GLB preview plus FBX split source', async () => {
    const requests: Array<{ action: string; body: Record<string, unknown>; authorization: string }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const action = headers.get('x-tc-action') ?? '';
      requests.push({
        action,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        authorization: headers.get('authorization') ?? '',
      });
      if (action === 'SubmitHunyuanTo3DProJob') return apiResponse({ JobId: 'g1', RequestId: 'r-submit' });
      if (action === 'QueryHunyuanTo3DProJob') {
        return apiResponse({
          Status: 'DONE',
          RequestId: 'r-query',
          ResultFile3Ds: [
            { Type: 'GLB', Url: 'https://cdn.example/model.glb' },
            { Type: 'FBX', Url: 'https://cdn.example/model.fbx' },
          ],
        });
      }
      throw new Error(`unexpected action ${action}`);
    };
    const engine = new HunyuanEngine({
      secretId: 'secret-id',
      secretKey: 'secret-key',
      fetchImpl,
      now: () => Date.UTC(2026, 7, 2),
      taskMap: taskMap(),
    });

    const submitted = await engine.submit({ type: 'text', prompt: '打印用机器人' }, 'bill-1');
    expect(submitted).toMatchObject({ taskId: 'hy3d_g1', status: 'queued', requestId: 'r-submit' });
    expect(requests[0].body).toMatchObject({ Model: '3.1', GenerateType: 'Geometry', ResultFormat: 'FBX', Prompt: '打印用机器人' });
    expect(requests[0].authorization).toMatch(/^TC3-HMAC-SHA256 Credential=secret-id\//);
    await expect(engine.resultAsset('hy3d_g1')).resolves.toEqual({ url: 'https://cdn.example/model.glb' });
    await expect(engine.sourceFbx('hy3d_g1')).resolves.toEqual({ url: 'https://cdn.example/model.fbx' });
  });

  it('runs generation and component split through the common Worker contract', async () => {
    const instances = new Map<string, QuotaDO>();
    const namespace = {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        const key = String(id);
        let instance = instances.get(key);
        if (!instance) {
          const mem = new Map<string, unknown>();
          const state: DurableState = {
            storage: {
              get: async <T,>(k: string) => mem.get(k) as T | undefined,
              put: async (k: string, value: unknown) => void mem.set(k, value),
            },
          };
          instance = new QuotaDO(state);
          instances.set(key, instance);
        }
        return { fetch: (url: string, init?: RequestInit) => instance!.fetch(new Request(url, init)) };
      },
    };
    const actions: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('challenges.cloudflare.com')) return Response.json({ success: true });
      if (url === 'https://cdn.example/model.glb') return new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
      if (url.startsWith('https://cdn.example/part-')) return new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
      const action = new Headers(init?.headers).get('x-tc-action') ?? '';
      actions.push(action);
      if (action === 'SubmitHunyuanTo3DProJob') return apiResponse({ JobId: 'g1', RequestId: 'rg1' });
      if (action === 'QueryHunyuanTo3DProJob') {
        return apiResponse({
          Status: 'DONE',
          RequestId: 'rg2',
          ResultFile3Ds: [
            { Type: 'GLB', Url: 'https://cdn.example/model.glb' },
            { Type: 'FBX', Url: 'https://cdn.example/model.fbx' },
          ],
        });
      }
      if (action === 'SubmitHunyuan3DPartJob') return apiResponse({ JobId: 'p1', RequestId: 'rp1' });
      if (action === 'QueryHunyuan3DPartJob') {
        return apiResponse({
          Status: 'DONE',
          RequestId: 'rp2',
          ResultFile3Ds: [
            { Type: 'GLB', Url: 'https://cdn.example/part-1.glb' },
            { Type: 'GLB', Url: 'https://cdn.example/part-2.glb' },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url} action=${action}`);
    };
    const env: WorkerEnv = {
      ASSETS: { fetch: async () => new Response('spa') },
      QUOTA_DO: namespace,
      TURNSTILE_SECRET_KEY: 'turnstile-secret',
      ENGINE_MODE: 'hunyuan',
      TENCENTCLOUD_SECRET_ID: 'secret-id',
      TENCENTCLOUD_SECRET_KEY: 'secret-key',
    };
    const call = (path: string, init?: RequestInit) => handleRequest(
      new Request(`https://app.example${path}`, init),
      env,
      { fetchImpl, now: () => Date.UTC(2026, 7, 2) },
    );

    const health = (await (await call('/api/health')).json()) as HealthResponse;
    expect(health.config).toMatchObject({ engineName: 'hunyuan', generationTypes: ['text', 'image', 'multiview'] });
    const generated = (await (await call('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': 'u1' },
      body: JSON.stringify({ type: 'text', prompt: 'robot', turnstileToken: 'ok' }),
    })).json()) as GenerateResponse;
    expect(generated).toMatchObject({ ok: true, engine: 'hunyuan', task: { taskId: 'hy3d_g1' } });

    const canceled = (await (await call('/api/task/hy3d_g1/cancel', {
      method: 'POST',
      headers: { 'x-client-id': 'u1' },
    })).json()) as CancelResponse;
    expect(canceled).toMatchObject({ ok: true, canceled: true, refunded: false });

    const submitted = (await (await call('/api/split', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': 'u1' },
      body: JSON.stringify({ sourceTaskId: 'hy3d_g1', level: 'medium', turnstileToken: 'ok' }),
    })).json()) as SplitSubmitResponse;
    expect(submitted).toMatchObject({ ok: true, engine: 'hunyuan', task: { taskId: 'hypart_p1' } });

    const manifest = (await (await call('/api/split/hypart_p1/result')).json()) as SplitResultManifestResponse;
    expect(manifest.parts).toEqual([
      { name: 'part_1.glb', url: '/api/split/hypart_p1/result/0' },
      { name: 'part_2.glb', url: '/api/split/hypart_p1/result/1' },
    ]);
    const part = await call('/api/split/hypart_p1/result/1');
    expect(part.status).toBe(200);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
    expect(actions).toContain('SubmitHunyuan3DPartJob');
  });
});
