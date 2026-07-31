import { beforeEach, describe, expect, it } from 'vitest';
import { clearHi3DTokenCache, HI3D_TOKEN_ENDPOINT } from '../worker/hi3d-client';
import {
  HI3D_GENERATE_ENDPOINT,
  HI3D_GENERATE_QUERY_ENDPOINT,
  Hi3DEngine,
  mapHi3DGenerateTask,
} from '../worker/hi3d-engine';
import {
  HI3D_SPLIT_ENDPOINT,
  HI3D_SPLIT_QUERY_ENDPOINT,
  Hi3DSplitEngine,
  mapHi3DSplitTask,
} from '../worker/hi3d-split-engine';

beforeEach(() => clearHi3DTokenCache());

function fakePng(name = 'front.png') {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

describe('Hi3D task mapping', () => {
  it('maps provider states to the shared lifecycle', () => {
    expect(mapHi3DGenerateTask({ task_id: 'g1', state: 'queueing' }, 'g1').status).toBe('queued');
    expect(mapHi3DGenerateTask({ task_id: 'g1', state: 'processing' }, 'g1')).toMatchObject({ status: 'running', progress: 45 });
    expect(mapHi3DGenerateTask({ task_id: 'g1', state: 'success' }, 'g1')).toMatchObject({
      status: 'success',
      resultUrl: '/api/task/g1/result',
    });
    expect(mapHi3DSplitTask({ task_id: 's1', state: 'success' }, 's1')).toMatchObject({
      status: 'success',
      resultUrl: '/api/split/s1/result',
    });
  });
});

describe('Hi3D generation adapter', () => {
  it('exchanges AK/SK for a token and submits a multi-view GLB task', async () => {
    const calls: Array<{ url: string; auth: string; body?: FormData }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      calls.push({ url, auth, body: init?.body instanceof FormData ? init.body : undefined });
      if (url === HI3D_TOKEN_ENDPOINT) {
        expect(auth).toMatch(/^Basic /);
        return Response.json({ code: 200, data: { accessToken: 'access-token', tokenType: 'Bearer' } });
      }
      if (url === HI3D_GENERATE_ENDPOINT) {
        expect(auth).toBe('Bearer access-token');
        return Response.json({ code: 200, data: { task_id: 'g1' } });
      }
      if (url === `${HI3D_GENERATE_QUERY_ENDPOINT}?task_id=g1`) {
        return Response.json({ code: 200, data: { task_id: 'g1', state: 'success', url: 'https://cdn.example/g1.glb' } });
      }
      throw new Error(`unexpected ${url}`);
    };
    const mapping = new Map<string, string>();
    const engine = new Hi3DEngine({
      accessKey: 'ak',
      secretKey: 'sk',
      model: 'hitem3dv2.1',
      resolution: '1536fast',
      faceCount: 500_000,
      timeoutMs: 900_000,
      fetchImpl,
      taskMap: {
        put: async (engineId, billingId) => void mapping.set(engineId, billingId),
        get: async (engineId) => mapping.get(engineId) ?? null,
      },
    });
    const task = await engine.submit(
      {
        type: 'multiview',
        images: [
          { view: 'front', file: fakePng('front.png') },
          { view: 'left', file: fakePng('left.png') },
          { view: 'right', file: fakePng('right.png') },
        ],
      },
      'bill-1',
    );
    expect(task).toMatchObject({ taskId: 'g1', status: 'queued' });
    expect(mapping.get('g1')).toBe('bill-1');
    const form = calls.find((call) => call.url === HI3D_GENERATE_ENDPOINT)?.body;
    expect(form?.get('request_type')).toBe('3');
    expect(form?.get('format')).toBe('2');
    expect(form?.get('multi_images_bit')).toBe('1011');
    expect(form?.getAll('multi_images')).toHaveLength(3);
    expect(await engine.resultAsset('g1')).toEqual({ url: 'https://cdn.example/g1.glb' });
    expect(calls.filter((call) => call.url === HI3D_TOKEN_ENDPOINT)).toHaveLength(1);
  });
});

describe('Hi3D split adapter', () => {
  it('submits GLB segmentation and exposes the temporary result URL only through the Worker', async () => {
    const calls: Array<{ url: string; auth: string; body?: FormData }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      calls.push({ url, auth, body: init?.body instanceof FormData ? init.body : undefined });
      if (url === HI3D_TOKEN_ENDPOINT) {
        expect(auth).toMatch(/^Basic /);
        return Response.json({ code: 200, data: { accessToken: 'split-token', tokenType: 'Bearer' } });
      }
      if (url === HI3D_SPLIT_ENDPOINT) {
        expect(auth).toBe('Token split-token');
        return Response.json({ code: 200, data: { task_id: 's1' } });
      }
      if (url === `${HI3D_SPLIT_QUERY_ENDPOINT}?task_id=s1`) {
        expect(auth).toBe('Token split-token');
        return Response.json({ code: 200, data: { task_id: 's1', state: 'success', url: 'https://cdn.example/s1.glb' } });
      }
      throw new Error(`unexpected ${url}`);
    };
    const engine = new Hi3DSplitEngine({ accessKey: 'ak', secretKey: 'sk', fetchImpl });
    const task = await engine.submit(
      { mesh: new File([new Uint8Array([1])], 'robot.glb', { type: 'model/gltf-binary' }), level: 'medium' },
      'bill-s1',
    );
    expect(task).toMatchObject({ taskId: 's1', status: 'queued' });
    const form = calls.find((call) => call.url === HI3D_SPLIT_ENDPOINT)?.body;
    expect(form?.get('seg_level')).toBe('medium');
    expect(form?.get('format')).toBe('2');
    expect(await engine.resultAsset('s1')).toEqual({ url: 'https://cdn.example/s1.glb' });
  });
});
