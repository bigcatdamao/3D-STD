// T11 双语义测试(IMP-02):finalize 的两条目标路径——
//   viewport = 入库 + 建实例(床中心/槽位 X + 自动沉底,历史 +1)
//   library  = 仅入库(无实例、历史不增,toast 引导从面板放置)
// 以及 placeFromLibrary(AST-03):床中心 + 沉底建实例;非就绪资产拒绝。

import { beforeEach, describe, expect, it } from 'vitest';
import { finalize, placeFromLibrary } from '../src/importer/ingest';
import type { InstanceNode } from '../src/kernel/types';
import { doc, geometryRegistry, thumbRegistry, useUi } from '../src/state/store';

const META = {
  faces: 2,
  vertices: 4,
  bboxRaw: { min: [0, 0, -5] as [number, number, number], max: [30, 30, 25] as [number, number, number] },
  watertight: true,
  degenerateCount: 0,
  boundaryEdges: 0,
  nonManifoldEdges: 0,
  materialMissing: false,
  gltfBaked: false,
};
const tri = () => new Float32Array([0, 0, -5, 30, 0, 0, 0, 30, 25, 0, 0, 0, 1, 0, 0, 0, 1, 0]);

function wipe() {
  for (const id of [...doc.nodes.keys()]) doc.nodes.delete(id);
  for (const k of [...doc.order.keys()]) doc.order.set(k, []);
  for (const id of [...doc.assets.keys()]) {
    doc.assets.delete(id);
    geometryRegistry.delete(id);
    thumbRegistry.delete(id);
  }
  doc.selection.clear();
  useUi.setState({ toast: null, importJobs: [] });
}

beforeEach(wipe);

describe('finalize 双语义(IMP-02)', () => {
  it('viewport:入库 + 建实例,槽位 X + 自动沉底(-bbox.min.z),历史 +1,自动选中', () => {
    const before = doc.history.length;
    const id = finalize('job1', '落场件', tri(), null, META, 'mm', 1, 60, 'viewport');
    expect(doc.assets.get(id)?.state).toBe('ready');
    expect(doc.assets.get(id)?.meta.createdAt).toBeGreaterThan(0);
    const inst = [...doc.nodes.values()].find((n): n is InstanceNode => n.kind === 'instance' && n.assetId === id);
    expect(inst?.transform.position).toEqual([60, 0, 5]); // 沉底:-(-5)
    expect(doc.history.length).toBe(before + 1);
    expect(doc.selection.has(inst!.id)).toBe(true);
  });

  it('library:仅入库——无实例、历史不增,toast 引导从面板放置', () => {
    const before = doc.history.length;
    const id = finalize('job2', '入库件', tri(), null, META, 'mm', 1, 0, 'library');
    expect(doc.assets.has(id)).toBe(true);
    expect([...doc.nodes.values()].some((n) => n.kind === 'instance' && n.assetId === id)).toBe(false);
    expect(doc.history.length).toBe(before); // 资产库操作不入栈
    expect(useUi.getState().toast?.text).toContain('已入库');
  });

  it('单位换算烘焙进几何与包围盒(cm ×10)', () => {
    const id = finalize('job3', '厘米件', tri(), null, META, 'cm', 10, 0, 'library');
    expect(doc.assets.get(id)?.meta.bbox.max).toEqual([300, 300, 250]);
    const pos = geometryRegistry.get(id)!.getAttribute('position');
    expect(pos.getX(1)).toBe(300);
  });
});

describe('placeFromLibrary(AST-03)', () => {
  it('就绪资产:床中心 + 自动沉底建实例,历史 +1', () => {
    const id = finalize('job4', '库存件', tri(), null, META, 'mm', 1, 0, 'library');
    const before = doc.history.length;
    expect(placeFromLibrary(id)).toBe(true);
    const inst = [...doc.nodes.values()].find((n): n is InstanceNode => n.kind === 'instance' && n.assetId === id);
    expect(inst?.transform.position).toEqual([0, 0, 5]);
    expect(doc.history.length).toBe(before + 1);
  });

  it('失效/无几何资产拒绝放置(边界 3:失效条目建不了实例)', () => {
    const id = finalize('job5', '将失效', tri(), null, META, 'mm', 1, 0, 'library');
    doc.assets.get(id)!.state = 'expired';
    expect(placeFromLibrary(id)).toBe(false);
    doc.assets.get(id)!.state = 'ready';
    geometryRegistry.delete(id);
    expect(placeFromLibrary(id)).toBe(false);
    expect(placeFromLibrary('ast_不存在')).toBe(false);
  });
});
