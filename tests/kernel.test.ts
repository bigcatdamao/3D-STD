// 每个用例头部标注其对应的 PRD 条款/验收样例 —— T2 的 DoD(backlog)。
import { describe, expect, it } from 'vitest';
import { HistoryManager } from '../src/kernel/history.js';
import { SceneDocument } from '../src/kernel/scene.js';
import { Asset } from '../src/kernel/types.js';

let t = 1000;
const clock = () => t;
const makeDoc = (cap = 50) =>
  new SceneDocument(new HistoryManager({ cap, now: clock }));

const anyAsset = (name = '齿轮底座', source: 'import' | 'ai' = 'import'): Omit<Asset, 'id'> => ({
  name,
  source,
  state: 'ready',
  meta: {
    faces: 1000,
    bbox: { min: [0, 0, 0], max: [10, 10, 10] },
    unitChoice: 'mm',
    watertight: true,
    degenerate: false,
  },
  ...(source === 'ai' ? { genParams: { prompt: 'a gear base', engine: 'tripo' } } : {}),
});

describe('C1 操作原子性', () => {
  it('平面切割把一件原子替换为两件，撤销/重做恢复资产、实例与层级位置', () => {
    const doc = makeDoc();
    const sourceAsset = doc.addAsset(anyAsset('角色'));
    const source = doc.placeInstance(sourceAsset.id);
    const sibling = doc.placeInstance(sourceAsset.id);
    doc.select([source.id]);
    const historyBefore = doc.history.length;

    const split = doc.splitInstanceWithDerivedParts(source.id, [
      anyAsset('角色 · A'),
      anyAsset('角色 · B'),
    ]);

    expect(doc.history.length).toBe(historyBefore + 1);
    expect(doc.nodes.has(source.id)).toBe(false);
    expect(doc.childrenOf(null)).toEqual([split.instances[0].id, split.instances[1].id, sibling.id]);
    expect([...doc.selection]).toEqual([split.instances[0].id, split.instances[1].id]);
    expect(split.instances.map((instance) => doc.instance(instance.id).assetId)).toEqual(
      split.assets.map((asset) => asset.id),
    );
    expect(doc.history.list().at(-1)).toMatchObject({ op: 'split', label: '平面切割为 2 个零件' });

    doc.history.undo();
    expect(doc.nodes.has(source.id)).toBe(true);
    expect(doc.childrenOf(null)).toEqual([source.id, sibling.id]);
    expect([...doc.selection]).toEqual([source.id]);
    expect(split.assets.every((asset) => !doc.assets.has(asset.id))).toBe(true);

    doc.history.redo();
    expect(doc.nodes.has(source.id)).toBe(false);
    expect(doc.childrenOf(null)).toEqual([split.instances[0].id, split.instances[1].id, sibling.id]);
    expect(split.assets.every((asset) => doc.assets.has(asset.id))).toBe(true);
  });

  it('多选批量删除 = 一步;撤销后全部恢复、呈选中、层级位置一致(PRD 6.7 验收样例 2)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const i3 = doc.placeInstance(a.id);
    const orderBefore = [...doc.childrenOf(null)];
    const lenBefore = doc.history.length;

    doc.select([i1.id, i2.id, i3.id]);
    doc.removeNodes([i1.id, i2.id, i3.id]);
    expect(doc.history.length).toBe(lenBefore + 1); // 仅 1 条
    expect(doc.nodes.size).toBe(0);

    doc.history.undo();
    expect(doc.nodes.size).toBe(3);
    expect([...doc.childrenOf(null)]).toEqual(orderBefore); // 层级位置一致
    expect([...doc.selection].sort()).toEqual([i1.id, i2.id, i3.id].sort()); // HIST-06 呈选中
  });

  it('gizmo 交互会话:任意次 update 松手后仅 1 条记录(PRD 6.7 验收样例 1)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    const lenBefore = doc.history.length;

    doc.beginInteraction('移动 · 齿轮底座', [i.id]);
    for (let k = 0; k < 180; k++)
      doc.updateInteraction((d) => (d.instance(i.id).transform.position[0] += 0.1));
    doc.commitInteraction();

    expect(doc.history.length).toBe(lenBefore + 1);
    expect(doc.instance(i.id).transform.position[0]).toBeCloseTo(18, 5);
    doc.history.undo();
    expect(doc.instance(i.id).transform.position[0]).toBe(0);
  });

  it('数值键入 800ms 窗口内合并为一条;窗口外为两条(C1)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    const lenBefore = doc.history.length;

    doc.setTransformField(i.id, 'position', 0, 5);
    t += 500;
    doc.setTransformField(i.id, 'position', 0, 12);
    expect(doc.history.length).toBe(lenBefore + 1); // 合并

    t += 900;
    doc.setTransformField(i.id, 'position', 0, 20);
    expect(doc.history.length).toBe(lenBefore + 2); // 窗口外新条目

    doc.history.undo();
    expect(doc.instance(i.id).transform.position[0]).toBe(12);
    doc.history.undo();
    expect(doc.instance(i.id).transform.position[0]).toBe(0); // 合并条回到最早 before
  });

  it('Esc 取消交互:回起点、不入栈(VIEW 边界 4)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    const lenBefore = doc.history.length;
    doc.beginInteraction('移动', [i.id]);
    doc.updateInteraction((d) => (d.instance(i.id).transform.position[1] = 99));
    doc.cancelInteraction();
    expect(doc.instance(i.id).transform.position[1]).toBe(0);
    expect(doc.history.length).toBe(lenBefore);
  });
});

describe('HIST-01 栈结构', () => {
  it('撤销后新操作静默截断 redo 分支', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    doc.rename(i.id, 'A');
    doc.rename(i.id, 'B');
    doc.history.undo(); // 回到 A
    doc.rename(i.id, 'C'); // 截断 B
    expect(doc.history.canRedo).toBe(false);
    doc.history.undo();
    expect(doc.nodes.get(i.id)!.name).toBe('A');
  });

  it('栈满丢最老并标记 overflow(上限可配)', () => {
    const doc = makeDoc(5);
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    for (let k = 0; k < 10; k++) {
      t += 1000; // 避开合并窗口
      doc.setTransformField(i.id, 'position', 0, k);
    }
    expect(doc.history.length).toBe(5);
    expect(doc.history.hasOverflowed).toBe(true);
  });
});

describe('HIST-05 / C2 AI 特殊规则与资产实例分离', () => {
  it('撤销「AI 生成落入」:实例移除、资产保留;重新落入不新建资产(PRD 6.7 验收样例 3)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset('生成的齿轮', 'ai'));
    const i = doc.placeInstance(a.id, 'AI 生成落入');
    doc.history.undo();
    expect(doc.nodes.has(i.id)).toBe(false);
    expect(doc.assets.has(a.id)).toBe(true); // 资产保留
    expect(doc.assets.get(a.id)!.genParams).toBeDefined(); // 生成参数完整(AST-02)
    doc.placeInstance(a.id, 'AI 生成落入'); // 从资产再拖入:无生成、无配额,仅新实例
    expect(doc.assets.size).toBe(1);
  });

  it('删除资产级联实例 = 一步;撤销后资产与实例全还原(TREE 验收样例 3)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    doc.placeInstance(a.id);
    doc.placeInstance(a.id);
    doc.placeInstance(a.id);
    const lenBefore = doc.history.length;
    doc.removeAssetCascade(a.id);
    expect(doc.history.length).toBe(lenBefore + 1);
    expect(doc.nodes.size).toBe(0);
    expect(doc.assets.size).toBe(0);
    doc.history.undo();
    expect(doc.nodes.size).toBe(3);
    expect(doc.assets.size).toBe(1);
  });
});

describe('TREE 组与 ID 稳定性', () => {
  it('解组撤销还原组名、成员顺序与父子关系(TREE 边界 2)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const g = doc.group([i1.id, i2.id], '机身组');
    doc.ungroup(g.id);
    expect(doc.nodes.has(g.id)).toBe(false);
    doc.history.undo();
    const gg = doc.nodes.get(g.id)!;
    expect(gg.name).toBe('机身组'); // 同 ID、同名回归(TREE 边界 7)
    expect(doc.childrenOf(g.id)).toEqual([i1.id, i2.id]);
    expect(doc.nodes.get(i1.id)!.parentId).toBe(g.id);
  });

  it('删除组 = 组及内容整树一步(TREE 边界 1)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const g = doc.group([i1.id, i2.id]);
    const lenBefore = doc.history.length;
    doc.removeNodes([g.id]);
    expect(doc.history.length).toBe(lenBefore + 1);
    expect(doc.nodes.size).toBe(0);
    doc.history.undo();
    expect(doc.nodes.size).toBe(3);
  });
});

describe('C7 / VIEW-04 / PANEL 锁定语义', () => {
  it('全选跳过锁定对象(VIEW-04)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    doc.setLocked([i2.id], true);
    doc.selectAll();
    expect([...doc.selection]).toEqual([i1.id]);
  });

  it('多选含 1 锁定改材质:仅未锁定生效、历史 1 条、撤销同步还原(PANEL 验收样例 3)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const i3 = doc.placeInstance(a.id);
    doc.setLocked([i3.id], true);
    const lenBefore = doc.history.length;

    const { skipped } = doc.setMaterialOverride([i1.id, i2.id, i3.id], { color: '#ff0000' });
    expect(skipped).toBe(1);
    expect(doc.history.length).toBe(lenBefore + 1);
    expect(doc.instance(i1.id).materialOverride).toEqual({ color: '#ff0000' });
    expect(doc.instance(i3.id).materialOverride).toBeUndefined();

    doc.history.undo();
    expect(doc.instance(i1.id).materialOverride).toBeUndefined();
    expect(doc.instance(i2.id).materialOverride).toBeUndefined();
  });
});

describe('PANEL-05 数值合法性', () => {
  it('旋转输入 450 归一为 90,且撤销一步直接回编辑前(PANEL 验收样例 2)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    t += 1000;
    doc.setTransformField(i.id, 'rotation', 2, 30);
    t += 1000;
    doc.setTransformField(i.id, 'rotation', 2, 450);
    expect(doc.instance(i.id).transform.rotation[2]).toBe(90); // 归一显示值即存储值
    doc.history.undo(); // 归一不产生额外记录:一步即回 30
    expect(doc.instance(i.id).transform.rotation[2]).toBe(30);
  });

  it('缩放 clamp:0 与负数被拦为 0.001(PANEL-05)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    doc.setTransformField(i.id, 'scale', 0, 0);
    expect(doc.instance(i.id).transform.scale[0]).toBe(0.001);
  });
});

describe('VIEW-06/07 沉底与预览冻结', () => {
  it('沉底:Zmin=-3 的对象底面归零且可撤销(VIEW 验收样例 2)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    doc.beginInteraction('移动', [i.id]);
    doc.updateInteraction((d) => (d.instance(i.id).transform.position[2] = -3));
    doc.commitInteraction();

    doc.dropToBed([i.id], (inst) => inst.transform.position[2]); // bbox min 在原点 → zMin = posZ
    expect(doc.instance(i.id).transform.position[2]).toBe(0);
    doc.history.undo();
    expect(doc.instance(i.id).transform.position[2]).toBe(-3);
  });

  it('预览态:编辑抛错、撤销无效;切回后历史与选中完整(VIEW 验收样例 3 / HIST 边界 1)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    doc.rename(i.id, 'A');
    const len = doc.history.length;
    doc.select([i.id]);

    doc.history.setFrozen(true);
    expect(() => doc.rename(i.id, 'B')).toThrow();
    expect(doc.history.undo()).toBe(false);

    doc.history.setFrozen(false);
    expect(doc.history.length).toBe(len);
    expect([...doc.selection]).toEqual([i.id]);
    expect(doc.history.undo()).toBe(true);
  });
});
