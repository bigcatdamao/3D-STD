// T14 内核侧补测 —— editVersion(CHK-03 过期信号)与修复命令(CHK-06 入栈可撤销)。
// editVersion 的口径必须与 C1 的「编辑」定义严格一致:入栈/合并/撤销/重做/装载递增,选中与相机不递增。

import { describe, expect, it } from 'vitest';
import { SceneDocument } from '../src/kernel/scene';
import type { Asset } from '../src/kernel/types';

const asset = (name: string): Omit<Asset, 'id'> => ({
  name,
  source: 'import',
  state: 'ready',
  meta: {
    faces: 12,
    bbox: { min: [-10, -10, -10], max: [10, 10, 10] },
    unitChoice: 'mm',
    watertight: true,
    degenerate: false,
  },
});

describe('editVersion(CHK-03 过期信号源)', () => {
  it('入栈递增;选中不递增(C1 同口径)', () => {
    const d = new SceneDocument();
    const v0 = d.editVersion;
    const a = d.addAsset(asset('件'));
    expect(d.editVersion).toBe(v0); // 资产入库不入栈,不递增
    const i = d.placeInstance(a.id);
    const v1 = d.editVersion;
    expect(v1).toBeGreaterThan(v0);
    d.select([i.id]);
    d.selectAll();
    expect(d.editVersion).toBe(v1); // 选中零递增
  });

  it('撤销/重做各递增一次(PRD 6.7 条款 6:检查结果随之过期)', () => {
    const d = new SceneDocument();
    const a = d.addAsset(asset('件'));
    d.placeInstance(a.id);
    const v = d.editVersion;
    d.history.undo();
    expect(d.editVersion).toBe(v + 1);
    d.history.redo();
    expect(d.editVersion).toBe(v + 2);
  });

  it('合并入栈(800ms 窗口)每次写入均递增 —— 面板连续键入期间结果持续过期', () => {
    const d = new SceneDocument();
    const a = d.addAsset(asset('件'));
    const i = d.placeInstance(a.id);
    const v = d.editVersion;
    d.setTransformField(i.id, 'position', 0, 5);
    d.setTransformField(i.id, 'position', 0, 8); // 与上一条合并为一条历史
    expect(d.history.length).toBe(2); // 导入 + 合并后的位移
    expect(d.editVersion).toBe(v + 2); // 但编辑信号发了两次
  });

  it('交互会话:commit 递增,cancel 不递增(Esc 回起点 = 未发生编辑)', () => {
    const d = new SceneDocument();
    const a = d.addAsset(asset('件'));
    const i = d.placeInstance(a.id);
    const v = d.editVersion;
    d.beginInteraction('拖动', [i.id]);
    d.updateInteraction(() => {
      d.instance(i.id).transform.position[0] = 50;
    });
    d.cancelInteraction();
    expect(d.editVersion).toBe(v);
    d.beginInteraction('拖动', [i.id]);
    d.updateInteraction(() => {
      d.instance(i.id).transform.position[0] = 50;
    });
    d.commitInteraction();
    expect(d.editVersion).toBe(v + 1);
  });

  it('hydrate 装载递增(装载不入栈但改变场景,既有结果失真)', () => {
    const d = new SceneDocument();
    const v = d.editVersion;
    d.hydrate([], []);
    expect(d.editVersion).toBe(v + 1);
  });
});

describe('CHK-06 修复命令', () => {
  it('nudgeInstances:平移增量一步入栈(op=fix),撤销回原位', () => {
    const d = new SceneDocument();
    const a = d.addAsset(asset('件'));
    const i = d.placeInstance(a.id, '导入', 'place', [125, 0, 10]);
    d.nudgeInstances([{ id: i.id, delta: [-7, 0, 0] }], '移回床内');
    expect(d.instance(i.id).transform.position).toEqual([118, 0, 10]);
    const top = d.history.list()[d.history.length - 1];
    expect(top.op).toBe('fix');
    expect(top.label).toBe('移回床内');
    d.history.undo();
    expect(d.instance(i.id).transform.position).toEqual([125, 0, 10]);
  });

  it('dropToBed 自定义标签:悬空修复以精确 zMin 落床,撤销恢复', () => {
    const d = new SceneDocument();
    const a = d.addAsset(asset('件'));
    const i = d.placeInstance(a.id, '导入', 'place', [0, 0, 13.2]);
    d.dropToBed([i.id], () => 3.2, '沉底 · 修复悬空'); // 检查 Worker 给出的几何精确 zMin
    expect(d.instance(i.id).transform.position[2]).toBeCloseTo(10, 6);
    const top = d.history.list()[d.history.length - 1];
    expect(top.op).toBe('drop');
    expect(top.label).toBe('沉底 · 修复悬空');
    d.history.undo();
    expect(d.instance(i.id).transform.position[2]).toBeCloseTo(13.2, 6);
  });

  it('nudgeInstances 空目标零操作(不入栈不递增)', () => {
    const d = new SceneDocument();
    const v = d.editVersion;
    d.nudgeInstances([{ id: 'ghost', delta: [1, 1, 1] }]);
    expect(d.history.length).toBe(0);
    expect(d.editVersion).toBe(v);
  });
});
