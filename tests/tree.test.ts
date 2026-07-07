// T7 场景树:内核扩展与拖拽纯逻辑。每个用例头部标注对应 PRD 条款(沿用 T2 DoD 口径)。
import { describe, expect, it } from 'vitest';
import { HistoryManager } from '../src/kernel/history.js';
import {
  dedupeName,
  nameFromFilename,
  nameFromPrompt,
  nextGroupName,
} from '../src/kernel/naming.js';
import { SceneDocument } from '../src/kernel/scene.js';
import { Asset } from '../src/kernel/types.js';
import { flattenVisible, resolveDrop, subtreeHeight } from '../src/tree/tree-logic.js';

let t = 1000;
const clock = () => (t += 1000); // 每次入栈拉开时距,避开合并窗口
const makeDoc = () => new SceneDocument(new HistoryManager({ now: clock }));

const anyAsset = (name = '齿轮底座'): Omit<Asset, 'id'> => ({
  name,
  source: 'import',
  state: 'ready',
  meta: {
    faces: 1000,
    bbox: { min: [0, 0, 0], max: [10, 10, 10] },
    unitChoice: 'mm',
    watertight: true,
    degenerate: false,
  },
});

describe('TREE-05 命名规则表', () => {
  it('导入 = 文件名去后缀(路径与多段扩展名安全)', () => {
    expect(nameFromFilename('gear_base.stl')).toBe('gear_base');
    expect(nameFromFilename('C:\\models\\支架 v2.final.glb')).toBe('支架 v2.final');
    expect(nameFromFilename('.gitignore')).toBe('.gitignore');
    expect(nameFromFilename('')).toBe('未命名');
  });

  it('AI = prompt 前 12 字符(按码点,中文安全;空回退)', () => {
    expect(nameFromPrompt('一只戴着宇航员头盔的柴犬,高精度')).toBe('一只戴着宇航员头盔的柴犬');
    expect(nameFromPrompt('cat')).toBe('cat');
    expect(nameFromPrompt('   ')).toBe('AI 模型');
  });

  it('重复加序号:「名称 2」起取最小可用;组 =「组 N」', () => {
    expect(dedupeName('底座', ['底座'])).toBe('底座 2');
    expect(dedupeName('底座', ['底座', '底座 2'])).toBe('底座 3');
    expect(dedupeName('底座', [])).toBe('底座');
    expect(nextGroupName(['组 1', '组 3'])).toBe('组 2');
  });

  it('实例继承资产名,二次落场自动加序号(允许手动重名:rename 不查重)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset('支架'));
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    expect(doc.nodes.get(i1.id)!.name).toBe('支架');
    expect(doc.nodes.get(i2.id)!.name).toBe('支架 2');
    doc.rename(i2.id, '支架'); // 手动重名允许(TREE-05)
    expect(doc.nodes.get(i2.id)!.name).toBe('支架');
  });

  it('rename:空名与未变更不入栈', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    const len = doc.history.length;
    doc.rename(i.id, '   ');
    doc.rename(i.id, doc.nodes.get(i.id)!.name);
    expect(doc.history.length).toBe(len);
  });

  it('group 默认命名「组 N」取最小空位', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const g1 = doc.group([i1.id]);
    const g2 = doc.group([i2.id]);
    expect(g1.name).toBe('组 1');
    expect(g2.name).toBe('组 2');
  });
});

describe('C7 三状态继承(组 → 成员叠加,自身标记保留)', () => {
  it('组隐藏 → 成员等效隐藏但自身 visible 标记不变;解除后即恢复', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    const g = doc.group([i.id]);
    doc.setVisible([g.id], false);
    expect(doc.nodes.get(i.id)!.visible).toBe(true); // 自身标记保留
    expect(doc.effectiveVisible(i.id)).toBe(false); // 等效隐藏
    doc.setVisible([g.id], true);
    expect(doc.effectiveVisible(i.id)).toBe(true);
  });

  it('组锁定 → 成员等效锁定;Ctrl+A 全选跳过(VIEW-04 × C7)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const g = doc.group([i1.id]);
    doc.setLocked([g.id], true);
    expect(doc.effectiveLocked(i1.id)).toBe(true);
    expect(doc.nodes.get(i1.id)!.locked).toBe(false);
    doc.selectAll();
    expect([...doc.selection]).toEqual([i2.id]); // 组与其成员均被跳过
  });
});

describe('TREE-04 拖拽排序与入组(moveNodes)', () => {
  const setup = () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const i3 = doc.placeInstance(a.id);
    return { doc, i1, i2, i3 };
  };

  it('同级排序 = 一步入栈,撤销还原顺序', () => {
    const { doc, i1, i2, i3 } = setup();
    const len = doc.history.length;
    doc.moveNodes([i3.id], null, i1.id); // i3 插到 i1 前
    expect(doc.childrenOf(null)).toEqual([i3.id, i1.id, i2.id]);
    expect(doc.history.length).toBe(len + 1);
    doc.history.undo();
    expect(doc.childrenOf(null)).toEqual([i1.id, i2.id, i3.id]);
  });

  it('多选拖入组 = 一步;组连同其成员被拖时只动组(topMost)', () => {
    const { doc, i1, i2, i3 } = setup();
    const g = doc.group([i1.id]);
    const len = doc.history.length;
    doc.moveNodes([i2.id, i3.id, i1.id, g.id], null, null); // i1 被 g 覆盖 → 实际动 [i2,i3,g]
    expect(doc.history.length).toBe(len + 1);
    expect(doc.nodes.get(i1.id)!.parentId).toBe(g.id); // 未被撕出组
    doc.moveNodes([i2.id, i3.id], g.id, null);
    expect(doc.childrenOf(g.id)).toEqual([i1.id, i2.id, i3.id]);
  });

  it('锁定组不接受拖入,含随组锁定的嵌套组(TREE 边界 3)', () => {
    const { doc, i1, i2 } = setup();
    const inner = doc.group([i1.id]);
    const outer = doc.group([inner.id]);
    doc.setLocked([outer.id], true);
    expect(() => doc.moveNodes([i2.id], inner.id, null)).toThrow(/锁定/);
  });

  it('禁止把组拖入其自身后代(成环)', () => {
    const { doc, i1 } = setup();
    const inner = doc.group([i1.id]);
    const outer = doc.group([inner.id]);
    expect(() => doc.moveNodes([outer.id], inner.id, null)).toThrow(/自身/);
  });
});

describe('TREE-01 嵌套与解组回填', () => {
  it('嵌套组解组:成员回填到组所在父级原位(非根);撤销完整还原(TREE 边界 2)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const inner = doc.group([i1.id, i2.id]);
    const outer = doc.group([inner.id]);
    doc.ungroup(inner.id);
    expect(doc.childrenOf(outer.id)).toEqual([i1.id, i2.id]); // 回填 outer,不落根
    expect(doc.nodes.get(i1.id)!.parentId).toBe(outer.id);
    doc.history.undo();
    expect(doc.childrenOf(outer.id)).toEqual([inner.id]);
    expect(doc.childrenOf(inner.id)).toEqual([i1.id, i2.id]);
  });

  it('多组解组 = 一步(C1 批量合并)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const g1 = doc.group([doc.placeInstance(a.id).id]);
    const g2 = doc.group([doc.placeInstance(a.id).id]);
    const len = doc.history.length;
    doc.ungroupMany([g1.id, g2.id]);
    expect(doc.history.length).toBe(len + 1);
    expect([...doc.nodes.values()].every((n) => n.kind === 'instance')).toBe(true);
  });

  it('成组落位:全员同父 → 组占首成员原位;空组保留(TREE 边界 6)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const i3 = doc.placeInstance(a.id);
    const g = doc.group([i2.id, i3.id]);
    expect(doc.childrenOf(null)).toEqual([i1.id, g.id]); // 组占 i2 原位
    doc.moveNodes([i2.id, i3.id], null, null); // 掏空组
    expect(doc.nodes.has(g.id)).toBe(true); // 空组不自动删除
    expect(doc.childrenOf(g.id)).toEqual([]);
  });
});

describe('快照对称性:变更父级操作的 undo/redo 往返(HIST-02 × 嵌套)', () => {
  it('移出组 → 撤销 → 重做:旧组顺序表无残留、目标序正确', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const g = doc.group([i1.id, i2.id]);
    doc.moveNodes([i1.id], null, null); // 移出到根
    doc.history.undo();
    expect(doc.childrenOf(g.id)).toEqual([i1.id, i2.id]);
    doc.history.redo();
    expect(doc.childrenOf(g.id)).toEqual([i2.id]); // 旧组无残留 id
    expect(doc.childrenOf(null)).toEqual([g.id, i1.id]);
  });

  it('删除组内成员 → 撤销 → 重做:组顺序表无残留', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const g = doc.group([i1.id, i2.id]);
    doc.removeNodes([i1.id]);
    doc.history.undo();
    doc.history.redo();
    expect(doc.childrenOf(g.id)).toEqual([i2.id]);
    expect(doc.nodes.has(i1.id)).toBe(false);
  });
});

describe('拖拽落点解析(resolveDrop)', () => {
  const setup = () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const i3 = doc.placeInstance(a.id);
    return { doc, i1, i2, i3 };
  };

  it('after 落点:插入参照取目标后首个未被拖动的兄弟', () => {
    const { doc, i1, i2, i3 } = setup();
    const plan = resolveDrop(doc, [i1.id, i2.id], { targetId: i1.id, zone: 'after' });
    // i1 被拖 → 落点无效(self);换 i3 之后
    expect(plan.ok).toBe(false);
    const plan2 = resolveDrop(doc, [i1.id], { targetId: i2.id, zone: 'after' });
    expect(plan2.ok && plan2.beforeId).toBe(i3.id);
  });

  it('无变化落点 = noop,不产生历史噪音', () => {
    const { doc, i1, i2 } = setup();
    const plan = resolveDrop(doc, [i1.id], { targetId: i2.id, zone: 'before' });
    expect(plan).toEqual({ ok: false, reason: 'noop' });
  });

  it('锁定组 into = locked;拖入自身后代 = cycle;多选按文档顺序归一', () => {
    const { doc, i1, i2, i3 } = setup();
    const g = doc.group([i1.id]);
    doc.setLocked([g.id], true);
    expect(resolveDrop(doc, [i2.id], { targetId: g.id, zone: 'into' })).toEqual({ ok: false, reason: 'locked' });
    doc.setLocked([g.id], false);
    expect(resolveDrop(doc, [g.id], { targetId: i1.id, zone: 'after' })).toEqual({ ok: false, reason: 'cycle' });
    const plan = resolveDrop(doc, [i3.id, i2.id], { targetId: g.id, zone: 'into' }); // 点击序倒置
    expect(plan.ok && plan.ids).toEqual([i2.id, i3.id]); // 文档序归一
  });

  it('深度软上限:落点使深度 > 5 → depthWarning,不拒绝(TREE-01)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    let g = doc.group([i.id]); // 深 1
    for (let k = 0; k < 4; k++) g = doc.group([g.id]); // 外层组深 1,i 深 6 已超,但这里测拖入
    const loose = doc.placeInstance(a.id);
    // 最内层组(含 i)深度 5 → 拖入后 loose 深 6
    const inner = doc.nodes.get(i.id)!.parentId!;
    const plan = resolveDrop(doc, [loose.id], { targetId: inner, zone: 'into' });
    expect(plan.ok && plan.depthWarning).toBe(true);
    expect(subtreeHeight(doc, loose.id)).toBe(1);
  });
});

describe('树展平(flattenVisible)', () => {
  it('折叠的组不展开子级;深度以根 = 1 计', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const g = doc.group([i1.id]);
    const open = flattenVisible(doc, new Set());
    expect(open.map((r) => r.id)).toEqual([g.id, i1.id, i2.id]);
    expect(open.find((r) => r.id === i1.id)!.depth).toBe(2);
    const folded = flattenVisible(doc, new Set([g.id]));
    expect(folded.map((r) => r.id)).toEqual([g.id, i2.id]);
  });
});
