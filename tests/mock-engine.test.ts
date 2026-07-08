// T4:mock 引擎单元测试 —— 统一任务协议(D4)的时间表推导、失败注入指令、
// 无效任务的 timeout 语义,以及 mock 结果 GLB 经真实导入管线(T10)可解析/水密/尺寸正确。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bboxOfPositions, decode, weldAndAnalyze } from '../src/importer/parse-core';
import type { EngineTask } from '../worker/api-types';
import { decodeMockTaskId, MockEngine, mockResultUrl, parseMockDirectives } from '../worker/mock-engine';

const req = (prompt: string) => ({ type: 'text' as const, prompt });

/** 可拨动的时钟 + 固定参数引擎 */
function rig(opts: { queueMs?: number; runMs?: number; failRate?: number; rand?: () => number } = {}) {
  const clock = { t: 1_000_000 };
  const engine = new MockEngine({ queueMs: 1000, runMs: 2000, ...opts, now: () => clock.t });
  return { clock, engine };
}

describe('mock 引擎 · 指令解析', () => {
  it('fail/queue/run/asset 四指令均可解析;时长支持 s/ms/裸毫秒', () => {
    const d = parseMockDirectives('一只小猫 @mock:fail=moderation @mock:queue=2s @mock:run=1500ms @mock:asset=ico');
    expect(d).toEqual({ fail: 'moderation', queueMs: 2000, runMs: 1500, asset: 1 });
    expect(parseMockDirectives('x @mock:queue=300').queueMs).toBe(300);
  });

  it('非法值静默忽略(不因演示指令写错而崩)', () => {
    const d = parseMockDirectives('@mock:fail=boom @mock:queue=abc @mock:asset=teapot');
    expect(d).toEqual({});
  });
});

describe('mock 引擎 · 时间表推导(成功链)', () => {
  it('排队 → 生成中(进度单调)→ 成功(resultUrl)', async () => {
    const { clock, engine } = rig();
    const t = await engine.submit(req('校准立方'), 't_bill_1');
    expect(t.status).toBe('queued');
    expect(t.progress).toBe(0);
    expect(t.queuePosition).toBeGreaterThanOrEqual(1);

    clock.t += 500; // 仍在排队
    expect((await engine.query(t.taskId)).status).toBe('queued');

    clock.t += 1000; // 进入生成(排队 1000 已过,run 进行到 500/2000)
    const running = await engine.query(t.taskId);
    expect(running.status).toBe('running');
    expect(running.progress).toBeGreaterThanOrEqual(1);
    expect(running.progress).toBeLessThanOrEqual(99);

    clock.t += 800;
    const later = await engine.query(t.taskId);
    expect(later.progress).toBeGreaterThan(running.progress); // 进度前进

    clock.t += 1000; // 越过 runEnd
    const done = await engine.query(t.taskId);
    expect(done.status).toBe('success');
    expect(done.progress).toBe(100);
    expect(done.resultUrl).toMatch(/^\/mock\/(cube|ico|cyl)\.glb$/);
  });

  it('同 prompt 的结果资产选取稳定(演示可复现);指令可指定', async () => {
    const { engine, clock } = rig();
    const a = await engine.submit(req('一只小猫'), 'b1');
    const b = await engine.submit(req('一只小猫'), 'b2');
    clock.t += 10_000;
    expect((await engine.query(a.taskId)).resultUrl).toBe((await engine.query(b.taskId)).resultUrl);
    const c = await engine.submit(req('随便 @mock:asset=cyl @mock:queue=0 @mock:run=1'), 'b3');
    clock.t += 10;
    expect((await engine.query(c.taskId)).resultUrl).toBe(mockResultUrl(2));
  });

  it('排队位置随时间递减且不小于 1(AI-03 位置反馈)', async () => {
    const { clock, engine } = rig({ queueMs: 6000 });
    const t = await engine.submit(req('x @mock:queue=6s'), 'b');
    const p0 = (await engine.query(t.taskId)).queuePosition!;
    clock.t += 4000;
    const p1 = (await engine.query(t.taskId)).queuePosition!;
    expect(p0).toBeGreaterThan(p1);
    expect(p1).toBeGreaterThanOrEqual(1);
  });
});

describe('mock 引擎 · 失败三分类的时间线性格(AI-05)', () => {
  const injectAt = async (fail: string, advance: number): Promise<EngineTask> => {
    const { clock, engine } = rig();
    const t = await engine.submit(req(`x @mock:fail=${fail}`), 'b');
    clock.t += advance;
    return engine.query(t.taskId);
  };

  it('moderation:排队结束即拒,进度停在 0', async () => {
    expect((await injectAt('moderation', 500)).status).toBe('queued'); // 排队期看不出异样
    const failed = await injectAt('moderation', 1001);
    expect(failed).toMatchObject({ status: 'failed', failReason: 'moderation', progress: 0 });
    // 永不进入 running
    expect((await injectAt('moderation', 60_000)).failReason).toBe('moderation');
  });

  it('service:生成中途(50%)崩', async () => {
    const running = await injectAt('service', 1500); // run 进行到 500/2000 < 50%
    expect(running.status).toBe('running');
    const failed = await injectAt('service', 2001); // 越过 queue+run/2 = 2000
    expect(failed).toMatchObject({ status: 'failed', failReason: 'service', progress: 50 });
  });

  it('timeout:进度爬满到点失败,永不 success', async () => {
    const nearEnd = await injectAt('timeout', 2900);
    expect(nearEnd.status).toBe('running');
    const failed = await injectAt('timeout', 3001);
    expect(failed).toMatchObject({ status: 'failed', failReason: 'timeout', progress: 99 });
    expect((await injectAt('timeout', 999_999)).status).toBe('failed');
  });

  it('MOCK_FAIL_RATE 随机注入:rand<rate 则失败且分类取自三类', async () => {
    const { clock, engine } = rig({ failRate: 1, rand: () => 0.4 });
    const t = await engine.submit(req('无指令'), 'b');
    clock.t += 60_000;
    const done = await engine.query(t.taskId);
    expect(done.status).toBe('failed');
    expect(['timeout', 'moderation', 'service']).toContain(done.failReason);
  });
});

describe('mock 引擎 · 账务键与无效任务', () => {
  it('taskId 内嵌账务键,billingIdOf 可还原(AI-07 返还闭环)', async () => {
    const { engine } = rig();
    const t = await engine.submit(req('x'), 't_ledger_42');
    expect(await engine.billingIdOf(t.taskId)).toBe('t_ledger_42');
    expect(decodeMockTaskId(t.taskId)?.sid).toBe('t_ledger_42');
  });

  it('垃圾 taskId:query 按 timeout 类失败(§4 失败语义),billingIdOf 为 null', async () => {
    const { engine } = rig();
    const q = await engine.query('garbage-id');
    expect(q).toMatchObject({ status: 'failed', failReason: 'timeout' });
    expect(await engine.billingIdOf('garbage-id')).toBeNull();
    expect(decodeMockTaskId('mk1_%%%')).toBeNull();
  });

  it('cancel 为无资源可释放的 no-op(不抛错;返还由路由层做)', async () => {
    const { engine } = rig();
    await expect(engine.cancel('anything')).resolves.toBeUndefined();
  });
});

describe('mock 结果资产 · 经真实导入管线(T10)验证', () => {
  const load = (name: string): ArrayBuffer => {
    const b = readFileSync(`public/mock/${name}.glb`);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };

  it('cube.glb:可解析、水密、Y-up 米 → Z-up 毫米烘焙后为 20mm 立方', async () => {
    const m = await decode('glb', load('cube'));
    expect(m.gltfBaked).toBe(true);
    const bb = bboxOfPositions(m.positions);
    for (let a = 0; a < 3; a++) expect(bb.max[a] - bb.min[a]).toBeCloseTo(20, 3);
    const topo = weldAndAnalyze(m.positions, m.index);
    expect(topo.watertight).toBe(true);
    expect(topo.degenerateCount).toBe(0);
  });

  it('ico.glb 与 cyl.glb:均水密、尺寸符合标称(Ø25 球径 / Ø20×30 柱)', async () => {
    const ico = await decode('glb', load('ico'));
    const bbI = bboxOfPositions(ico.positions);
    expect(bbI.max[0] - bbI.min[0]).toBeGreaterThan(20); // 二十面体外接球 Ø25,投影跨度略小于 25
    expect(weldAndAnalyze(ico.positions, ico.index).watertight).toBe(true);

    const cyl = await decode('glb', load('cyl'));
    const bbC = bboxOfPositions(cyl.positions);
    expect(bbC.max[0] - bbC.min[0]).toBeCloseTo(20, 1); // X 直径
    expect(bbC.max[2] - bbC.min[2]).toBeCloseTo(30, 1); // 原 Y 高度烘焙到 Z
    expect(weldAndAnalyze(cyl.positions, cyl.index).watertight).toBe(true);
  });
});
