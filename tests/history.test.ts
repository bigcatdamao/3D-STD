// T9 历史面板 —— 内核元数据(op/targetNames)与面板纯逻辑的单元测试。
// 每个用例头部标注对应 PRD 条款(HIST-04/07/08 + 边界),与 kernel.test.ts 同一惯例。
import { describe, expect, it } from 'vitest';
import { buildRows, expandHighlightIds, nameSummary } from '../src/history/history-logic.js';
import { OP_TABLE, OpKind } from '../src/kernel/history-labels.js';
import { HistoryManager } from '../src/kernel/history.js';
import { SceneDocument } from '../src/kernel/scene.js';
import { Asset } from '../src/kernel/types.js';

let t = 1000;
const clock = () => t;
const makeDoc = (cap = 50) => new SceneDocument(new HistoryManager({ cap, now: clock }));

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

describe('HIST-07 命名规范表', () => {
  it('每个操作类型都有非空图标与显示文案(表 = 单一权威源)', () => {
    for (const [op, { icon, name }] of Object.entries(OP_TABLE)) {
      expect(icon, `${op} 缺图标`).toBeTruthy();
      expect(name, `${op} 缺文案`).toBeTruthy();
    }
  });

  it('每条入栈记录都携带表内合法的 op(commit 首参强制声明)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    doc.rename(i1.id, '外壳');
    doc.setVisible([i2.id], false);
    doc.setLocked([i2.id], true);
    const g = doc.group([i1.id]);
    doc.ungroup(g.id);
    doc.setTransformField(i1.id, 'position', 0, 42);
    t += 2000; // 越过合并窗口
    doc.dropToBed([i1.id], () => -5);
    doc.removeNodes([i1.id]);
    const ops = doc.history.list().map((e) => e.op);
    expect(ops).toEqual([
      'place', 'place', 'rename', 'hide', 'lock', 'group', 'ungroup', 'transform', 'drop', 'remove',
    ] satisfies OpKind[]);
    for (const op of ops) expect(OP_TABLE[op]).toBeDefined();
  });
});

describe('HIST-04 目标名快照', () => {
  it('删除条目在节点移除后仍能显示对象名(入栈时刻快照,非活查)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset('支架'));
    const i1 = doc.placeInstance(a.id); // 支架
    const i2 = doc.placeInstance(a.id); // 支架 2
    doc.removeNodes([i1.id, i2.id]);
    const last = doc.history.list().at(-1)!;
    expect(doc.nodes.has(i1.id)).toBe(false); // 节点确已不在文档
    expect(last.targetNames).toEqual(['支架', '支架 2']);
  });

  it('新建类操作(变更前节点不存在)在 mutate 后补取名字', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset('花瓶'));
    doc.placeInstance(a.id);
    expect(doc.history.list()[0].targetNames).toEqual(['花瓶']);
  });

  it('800ms 合并窗口内,合并条目的 op 与名字随最新一次更新(C1 第二类)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    t += 2000;
    doc.setTransformField(i.id, 'position', 0, 10);
    t += 300;
    doc.setTransformField(i.id, 'position', 0, 20); // 合并进上一条
    const list = doc.history.list();
    expect(list.length).toBe(2); // place + 合并后的 transform
    expect(list[1].op).toBe('transform');
    expect(list[1].targetNames).toEqual(['齿轮底座']);
  });
});

describe('HIST-04 点击跳转(jumpTo)', () => {
  it('跳转 = 批量撤销/重做,越界位置钳制到 [0, length]', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    t += 2000;
    doc.setTransformField(i.id, 'position', 0, 10);
    t += 2000;
    doc.setTransformField(i.id, 'position', 0, 30);
    expect(doc.history.position).toBe(3);

    doc.history.jumpTo(1); // 批量撤销 2 步:回到刚落场
    expect(doc.history.position).toBe(1);
    expect(doc.instance(i.id).transform.position[0]).toBe(0);

    doc.history.jumpTo(999); // 越界 → 钳到栈顶,批量重做
    expect(doc.history.position).toBe(3);
    expect(doc.instance(i.id).transform.position[0]).toBe(30);

    doc.history.jumpTo(-5); // 越界 → 钳到 0,实例被移除(撤销落场),资产保留(HIST-05)
    expect(doc.history.position).toBe(0);
    expect(doc.nodes.has(i.id)).toBe(false);
    expect(doc.assets.has(a.id)).toBe(true);
  });

  it('冻结时 jumpTo 静默无效(HIST 边界 1)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    doc.placeInstance(a.id);
    doc.history.setFrozen(true);
    doc.history.jumpTo(0);
    expect(doc.history.position).toBe(1); // 未动
    doc.history.setFrozen(false);
  });
});

describe('面板行模型(buildRows / nameSummary)', () => {
  it('applied/current 标记正确划分撤销与重做两侧', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    t += 2000;
    doc.setTransformField(i.id, 'position', 1, 5);
    doc.history.undo();
    const rows = buildRows(doc.history.list(), doc.history.position);
    expect(rows.map((r) => r.applied)).toEqual([true, false]); // 第二条已撤销 → redo 侧
    expect(rows.map((r) => r.current)).toEqual([true, false]);
    expect(rows[0].icon).toBe(OP_TABLE.place.icon);
    expect(rows[1].position).toBe(2); // 点击第二条 → jumpTo(2)
  });

  it('目标名摘要:1 个直显、2 个并列、3+ 折叠', () => {
    expect(nameSummary([])).toBe('');
    expect(nameSummary(['A'])).toBe('A');
    expect(nameSummary(['A', 'B'])).toBe('A、B');
    expect(nameSummary(['A', 'B', 'C'])).toBe('A 等 3 项');
  });
});

describe('HIST-08 hover 高亮展开', () => {
  it('组展开为后代实例;已删除目标静默跳过;锁定不剔除(只读呈现语义)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const i3 = doc.placeInstance(a.id);
    const g = doc.group([i1.id, i2.id]);
    doc.setLocked([i2.id], true);
    expect(new Set(expandHighlightIds(doc, [g.id]))).toEqual(new Set([i1.id, i2.id])); // 含锁定成员
    doc.removeNodes([i3.id]);
    expect(expandHighlightIds(doc, [i3.id, i1.id])).toEqual([i1.id]); // 已删除跳过
  });
});
