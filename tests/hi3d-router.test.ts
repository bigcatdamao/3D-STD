import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiError, GenerateResponse, HealthResponse, SplitSubmitResponse, SplitTaskResponse } from '../worker/api-types';
import { HI3D_TOKEN_ENDPOINT, clearHi3DTokenCache } from '../worker/hi3d-client';
import { HI3D_GENERATE_ENDPOINT, HI3D_GENERATE_QUERY_ENDPOINT } from '../worker/hi3d-engine';
import { HI3D_SPLIT_ENDPOINT, HI3D_SPLIT_QUERY_ENDPOINT } from '../worker/hi3d-split-engine';
import { QuotaDO, type DurableState } from '../worker/quota-do';
import { handleRequest, type WorkerEnv } from '../worker/router';

function makeWorld() {
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
  const generateTasks = new Map<string, { state: string; url?: string }>();
  const splitTasks = new Map<string, { state: string; url?: string }>();
  const upstream = { generationForm: null as FormData | null, splitForm: null as FormData | null };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('challenges.cloudflare.com')) return Response.json({ success: true });
    if (url === HI3D_TOKEN_ENDPOINT) {
      return Response.json({ code: 200, data: { accessToken: 'server-token', tokenType: 'Bearer' } });
    }
    if (url === HI3D_GENERATE_ENDPOINT) {
      upstream.generationForm = init?.body as FormData;
      generateTasks.set('g1', { state: 'queueing' });
      return Response.json({ code: 200, data: { task_id: 'g1' } });
    }
    if (url.startsWith(`${HI3D_GENERATE_QUERY_ENDPOINT}?`)) {
      const id = new URL(url).searchParams.get('task_id')!;
      return Response.json({ code: 200, data: { task_id: id, ...(generateTasks.get(id) ?? { state: 'failed' }) } });
    }
    if (url === HI3D_SPLIT_ENDPOINT) {
      const contentType = new Headers(init?.headers).get('content-type') ?? '';
      upstream.splitForm = await new Response(init?.body, { headers: { 'content-type': contentType } }).formData();
      splitTasks.set('s1', { state: 'queueing' });
      return Response.json({ code: 200, data: { task_id: 's1' } });
    }
    if (url.startsWith(`${HI3D_SPLIT_QUERY_ENDPOINT}?`)) {
      const id = new URL(url).searchParams.get('task_id')!;
      return Response.json({ code: 200, data: { task_id: id, ...(splitTasks.get(id) ?? { state: 'failed' }) } });
    }
    if (url === 'https://cdn.example/split.glb') {
      return new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]), { headers: { 'content-type': 'model/gltf-binary' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const env: WorkerEnv = {
    ASSETS: { fetch: async () => new Response('spa') },
    QUOTA_DO: namespace,
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    ENGINE_MODE: 'hi3d',
    HI3D_ACCESS_KEY: 'ak',
    HI3D_SECRET_KEY: 'sk',
  };
  const call = (path: string, init?: RequestInit) =>
    handleRequest(new Request(`https://app.example${path}`, init), env, { fetchImpl });
  return { env, call, generateTasks, splitTasks, upstream };
}

beforeEach(() => {
  clearHi3DTokenCache();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('M1.13a Hi3D Worker integration', () => {
  it('reports image-only generation capabilities and rejects text before billing', async () => {
    const w = makeWorld();
    const health = (await (await w.call('/api/health')).json()) as HealthResponse;
    expect(health.config).toMatchObject({ engine: true, engineName: 'hi3d', generationTypes: ['image', 'multiview'] });
    const result = await w.call('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'text', prompt: 'robot', turnstileToken: 'ok' }),
    });
    expect(result.status).toBe(400);
    expect((await result.json()) as ApiError).toMatchObject({ error: 'generation_type_unsupported' });
  });

  it('creates an image-to-3D task through the common generation lifecycle', async () => {
    const w = makeWorld();
    const form = new FormData();
    form.set('type', 'image');
    form.set('prompt', 'robot');
    form.set('turnstileToken', 'ok');
    form.set('image_front', new File([new Uint8Array([1])], 'robot.png', { type: 'image/png' }));
    const response = await w.call('/api/generate', { method: 'POST', headers: { 'x-client-id': 'u1' }, body: form });
    const body = (await response.json()) as GenerateResponse;
    expect(body).toMatchObject({ ok: true, engine: 'hi3d', task: { taskId: 'g1', status: 'queued' } });
    expect(w.upstream.generationForm?.get('format')).toBe('2');
  });

  it('creates, polls and proxies a real semantic-split contract', async () => {
    const w = makeWorld();
    const form = new FormData();
    const mesh = new File([new Uint8Array([1])], 'robot.glb', { type: 'model/gltf-binary' });
    form.set('mesh', mesh);
    form.set('seg_level', 'medium');
    form.set('format', '2');
    const response = await w.call('/api/split', {
      method: 'POST',
      headers: {
        'x-client-id': 'u1',
        'x-turnstile-token': 'ok',
        'x-mesh-name': encodeURIComponent(mesh.name),
        'x-mesh-size': String(mesh.size),
        'x-split-level': 'medium',
      },
      body: form,
    });
    const submitted = (await response.json()) as SplitSubmitResponse;
    expect(submitted).toMatchObject({ ok: true, engine: 'hi3d', task: { taskId: 's1', status: 'queued' } });
    expect(w.upstream.splitForm?.get('seg_level')).toBe('medium');

    w.splitTasks.set('s1', { state: 'success', url: 'https://cdn.example/split.glb' });
    const query = (await (await w.call('/api/split/s1')).json()) as SplitTaskResponse;
    expect(query.task).toMatchObject({ status: 'success', resultUrl: '/api/split/s1/result' });
    const result = await w.call('/api/split/s1/result');
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('model/gltf-binary');
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
  });
});
