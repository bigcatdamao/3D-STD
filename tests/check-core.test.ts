// T14 检查核心单测 —— CHK-01(三级判定)/ CHK-04(资产级分析产物)/ CHK-06(修复增量)。
// 几何精确性重点:旋转对象的逐顶点 zMin 必须严于「变换 bbox 角点」的保守近似。

import { describe, expect, it } from 'vitest';
import {
  BED_EPS_MM,
  FLOATING_MM,
  TINY_MM,
  analyzeAssetGeometry,
  checkInstance,
  clampIntoBedDelta,
  isReportStale,
  worldStats,
} from '../src/check/check-core';
import { worldBBoxOfInstance } from '../src/viewport/gizmo-math';
import type { Transform } from '../src/kernel/types';

const BED = { x: 256, y: 256, z: 256 };
const T = (p: [number, number, number], r: [number, number, number] = [0, 0, 0], s: [number, number, number] = [1, 1, 1]): Transform => ({
  position: p,
  rotation: r,
  scale: s,
});

// ---------- 夹具几何 ----------

/** 闭合立方体(边长 size,中心在原点):12 三角非索引 */
function cube(size: number): Float32Array {
  const h = size / 2;
  const v = (x: number, y: number, z: number): [number, number, number] => [x * h, y * h, z * h];
  const quads: [number, number, number][][] = [
    [v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1)], // -Z
    [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)], // +Z
    [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)], // -Y
    [v(1, 1, -1), v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1)], // +Y
    [v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)], // +X
    [v(-1, 1, -1), v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1)], // -X
  ];
  const out: number[] = [];
  for (const [a, b, c, d] of quads) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  return new Float32Array(out);
}

/** 顶面缺失的开口盒:10 三角,顶缘 4 条边界边 */
function openBoxExplicit(size: number): Float32Array {
  const h = size / 2;
  const v = (x: number, y: number, z: number): [number, number, number] => [x * h, y * h, z * h];
  const quads: [number, number, number][][] = [
    [v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1)],
    [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)],
    [v(1, 1, -1), v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1)],
    [v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)],
    [v(-1, 1, -1), v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1)],
  ];
  const out: number[] = [];
  for (const [a, b, c, d] of quads) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  return new Float32Array(out);
}

describe('资产级分析(CHK-04)', () => {
  it('闭合立方体:水密、零边界边、无描红线段', () => {
    const r = analyzeAssetGeometry(cube(20), null);
    expect(r.watertight).toBe(true);
    expect(r.boundaryEdges).toBe(0);
    expect(r.boundarySegments.length).toBe(0);
    expect(r.faces).toBe(12);
  });

  it('开口盒:非水密、顶缘 4 条边界边、描红线段端点落在顶缘 z=+h', () => {
    const r = analyzeAssetGeometry(openBoxExplicit(20), null);
    expect(r.watertight).toBe(false);
    expect(r.boundaryEdges).toBe(4);
    expect(r.boundarySegments.length).toBe(4 * 6); // 4 段 × 两端点 × xyz
    for (let i = 2; i < r.boundarySegments.length; i += 3) {
      expect(r.boundarySegments[i]).toBeCloseTo(10, 5); // 所有端点 z = +10(顶缘)
    }
  });
});

describe('精确世界包围盒(几何精确 vs bbox 近似)', () => {
  it('无旋转:与变换 bbox 一致', () => {
    const t = T([5, -3, 12], [0, 0, 0], [2, 1, 1]);
    const w = worldStats(cube(20), t);
    expect(w.min).toEqual([-15, -13, 2]);
    expect(w.max).toEqual([25, 7, 22]);
  });

  it('旋转 45°:逐顶点 zMin 与 bbox 角点法一致(立方体角点即顶点),但语义为几何精确', () => {
    const t = T([0, 0, 30], [45, 0, 0]);
    const w = worldStats(cube(20), t);
    const approx = worldBBoxOfInstance(t, { min: [-10, -10, -10], max: [10, 10, 10] });
    expect(w.min[2]).toBeCloseTo(approx.min.z, 4);
    expect(w.min[2]).toBeCloseTo(30 - 10 * Math.SQRT2, 4);
  });

  it('非盒体旋转:逐顶点 zMin 严于 bbox 角点近似(bbox 会虚报更低)', () => {
    // 八面体:bbox 角点 (±10,±10,±15) 不在实体上 —— 斜置后 bbox 法显著虚报
    const vx = [10, 0, 0], vX = [-10, 0, 0], vy = [0, 10, 0], vY = [0, -10, 0], vz = [0, 0, 15], vZ = [0, 0, -15];
    const tris = [
      [vx, vy, vz], [vy, vX, vz], [vX, vY, vz], [vY, vx, vz],
      [vy, vx, vZ], [vX, vy, vZ], [vY, vX, vZ], [vx, vY, vZ],
    ];
    const pos = new Float32Array(tris.flat(2));
    const t = T([0, 0, 25], [50, 0, 0]);
    const exact = worldStats(pos, t);
    const bb = { min: [-10, -10, -15] as [number, number, number], max: [10, 10, 15] as [number, number, number] };
    const approx = worldBBoxOfInstance(t, bb);
    expect(exact.min[2]).toBeGreaterThan(approx.min.z + 5); // 精确值明显更高 → 沉底修复不会过冲
    expect(exact.min[2]).toBeCloseTo(25 - 15 * Math.cos((50 * Math.PI) / 180) - 0, 1);
  });
});

describe('三级判定(CHK-01)与修复参数(CHK-06)', () => {
  const topoOK = { faces: 12, watertight: true, boundaryEdges: 0, nonManifoldEdges: 0, degenerateCount: 0 };
  const inst = (id: string) => ({ id, name: id, assetId: 'a1' });

  it('贴床合法对象:无错误无警告,仅 1 条尺寸信息', () => {
    const w = worldStats(cube(20), T([0, 0, 10]));
    const issues = checkInstance(inst('i1'), topoOK, w, BED);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('dims');
    expect(issues[0].message).toContain('20.0 × 20.0 × 20.0 mm');
  });

  it('悬空:zMin > 0.5mm 报警告并携带精确 zMin 修复参数;0.5mm 以内不报', () => {
    const wFloat = worldStats(cube(20), T([0, 0, 10 + 3.2]));
    const floating = checkInstance(inst('i1'), topoOK, wFloat, BED).find((i) => i.code === 'floating')!;
    expect(floating.level).toBe('warning');
    expect(floating.fix).toEqual({ kind: 'drop', zMin: expect.closeTo(3.2, 4) });

    const wTouch = worldStats(cube(20), T([0, 0, 10 + FLOATING_MM - 0.01]));
    expect(checkInstance(inst('i1'), topoOK, wTouch, BED).find((i) => i.code === 'floating')).toBeUndefined();
  });

  it('超床(+X 越界):错误级 + clamp 增量恰好移回床内', () => {
    const w = worldStats(cube(20), T([125, 0, 10])); // max.x = 135 > 128
    const oob = checkInstance(inst('i1'), topoOK, w, BED).find((i) => i.code === 'out_of_bed')!;
    expect(oob.level).toBe('error');
    expect(oob.fix).toMatchObject({ kind: 'clamp', fullyFixable: true });
    const fix = oob.fix as { delta: [number, number, number] };
    expect(fix.delta[0]).toBeCloseTo(-7, 4);
    expect(fix.delta[1]).toBe(0);
  });

  it('沉入床下:归超床错误(床下),不重复报悬空', () => {
    const w = worldStats(cube(20), T([0, 0, 4])); // zMin = -6
    const issues = checkInstance(inst('i1'), topoOK, w, BED);
    expect(issues.find((i) => i.code === 'out_of_bed')).toBeTruthy();
    expect(issues.find((i) => i.code === 'floating')).toBeUndefined();
    const fix = issues.find((i) => i.code === 'out_of_bed')!.fix as { delta: [number, number, number] };
    expect(fix.delta[2]).toBeCloseTo(6, 4); // 抬回床面
  });

  it('对象尺寸超过打印体积:fullyFixable=false(平移无解)', () => {
    const { fullyFixable, delta } = clampIntoBedDelta(
      { min: [-200, -10, 0], max: [200, 10, 20] }, // X 向 400 > 256
      BED,
    );
    expect(fullyFixable).toBe(false);
    expect(delta[1]).toBe(0);
  });

  it('微小件:最大边长 < 2mm 报警告', () => {
    const w = worldStats(cube(20), T([0, 0, 0.05], [0, 0, 0], [0.005, 0.005, 0.005])); // 0.1mm
    const tiny = checkInstance(inst('i1'), topoOK, w, BED).find((i) => i.code === 'tiny');
    expect(tiny?.level).toBe('warning');
    expect(TINY_MM).toBe(2);
  });

  it('非水密 + 退化:错误级各一条,非水密文案提供安全修复预览入口', () => {
    const topoBad = { faces: 10, watertight: false, boundaryEdges: 4, nonManifoldEdges: 0, degenerateCount: 2 };
    const w = worldStats(openBoxExplicit(20), T([0, 0, 10]));
    const issues = checkInstance(inst('i1'), topoBad, w, BED);
    const nw = issues.find((i) => i.code === 'non_watertight')!;
    expect(nw.level).toBe('error');
    expect(nw.message).toContain('4 条开放边界边');
    expect(nw.message).toContain('安全修复预览');
    expect(issues.find((i) => i.code === 'degenerate')?.message).toContain('2 个退化面片');
  });

  it('贴边容差:恰好压线(±BED_EPS_MM 内)不误报超床', () => {
    const w = worldStats(cube(20), T([118, 0, 10])); // max.x = 128 恰好贴边
    expect(checkInstance(inst('i1'), topoOK, w, BED).find((i) => i.code === 'out_of_bed')).toBeUndefined();
    expect(BED_EPS_MM).toBeGreaterThan(0);
  });
});

describe('过期判定(CHK-03)', () => {
  it('editVersion 或床配置任一变化即过期', () => {
    const meta = { editVersion: 7, bed: { ...BED } };
    expect(isReportStale(meta, 7, BED)).toBe(false);
    expect(isReportStale(meta, 8, BED)).toBe(true);
    expect(isReportStale(meta, 7, { ...BED, z: 180 })).toBe(true);
  });
});
