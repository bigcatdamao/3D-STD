// T8 参数面板 —— 内核命令族与纯逻辑层测试。每个用例头部标注对应 PRD 条款/验收样例。
import { describe, expect, it } from 'vitest';
import { HistoryManager } from '../src/kernel/history.js';
import { SceneDocument } from '../src/kernel/scene.js';
import { Asset } from '../src/kernel/types.js';
import {
  commonValue,
  localSizeMm,
  panelTargets,
  parseNumeric,
  scaleFromSizeMm,
  stepDelta,
  targetsBBox,
} from '../src/panel/panel-logic.js';

let t = 1000;
const clock = () => t;
const makeDoc = (cap = 50) => new SceneDocument(new HistoryManager({ cap, now: clock }));

const anyAsset = (name = '面板样件'): Omit<Asset, 'id'> => ({
  name,
  source: 'import',
  state: 'ready',
  meta: {
    faces: 100,
    bbox: { min: [0, 0, 0], max: [10, 10, 10] },
    unitChoice: 'mm',
    watertight: true,
    degenerate: false,
  },
});

describe('PANEL-03 多选语义', () => {
  it('3 个 X 不同的对象:位置显示包围盒中心;中心 +20 = 整体平移,两两相对距离不变(验收样例 1)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const xs = [0, 30, 90];
    const insts = xs.map((x) => {
      const i = doc.placeInstance(a.id);
      t += 1000;
      doc.setTransformField(i.id, 'position', 0, x);
      t += 1000;
      return i;
    });
    doc.select(insts.map((i) => i.id));

    // 显示口径:包围盒中心(bbox 0..10 → 世界 X 范围 [0, 100],中心 50)
    const box = targetsBBox(doc, panelTargets(doc).editable)!;
    expect(box.center[0]).toBeCloseTo(50, 6);

    // 编辑口径:输入 70 → delta = +20,整体平移
    const lenBefore = doc.history.length;
    doc.translateInstancesAxis(insts.map((i) => i.id), 0, 70 - box.center[0]);
    const nx = insts.map((i) => doc.instance(i.id).transform.position[0]);
    expect(nx).toEqual([20, 50, 110]); // 相对距离 30/60 保持
    expect(doc.history.length).toBe(lenBefore + 1); // 多选批量 = 一步(C1)

    doc.history.undo();
    expect(insts.map((i) => doc.instance(i.id).transform.position[0])).toEqual(xs);
  });

  it('多选旋转输入 = 绝对统一,归一后单条记录;连续键入 800ms 合并(C1/C6)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    t += 1000;
    doc.setTransformField(i2.id, 'rotation', 2, 30); // 制造混合值
    t += 1000;
    const lenBefore = doc.history.length;

    doc.setTransformFieldMulti([i1.id, i2.id], 'rotation', 2, 450); // 归一 → 90
    expect(doc.instance(i1.id).transform.rotation[2]).toBe(90);
    expect(doc.instance(i2.id).transform.rotation[2]).toBe(90);
    expect(doc.history.length).toBe(lenBefore + 1);

    t += 500;
    doc.setTransformFieldMulti([i1.id, i2.id], 'rotation', 2, 45); // 窗口内 → 合并
    expect(doc.history.length).toBe(lenBefore + 1);

    doc.history.undo(); // 合并条回到最早 before
    expect(doc.instance(i1.id).transform.rotation[2]).toBe(0);
    expect(doc.instance(i2.id).transform.rotation[2]).toBe(30);
  });

  it('无变化不入栈:全体已等于目标值时提交为空操作', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    const lenBefore = doc.history.length;
    doc.setTransformFieldMulti([i.id], 'position', 1, 0); // 已是 0
    expect(doc.history.length).toBe(lenBefore);
  });
});

describe('PANEL-04/05 缩放与合法性', () => {
  it('等比系数作用于三轴且逐分量 clamp ≥0.001;可撤销一步', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    doc.beginInteraction('缩放', [i.id]);
    doc.updateInteraction((d) => (d.instance(i.id).transform.scale = [1, 2, 0.004]));
    doc.commitInteraction();
    const lenBefore = doc.history.length;

    doc.scaleInstancesFactor([i.id], 0.1);
    expect(doc.instance(i.id).transform.scale[0]).toBeCloseTo(0.1, 9);
    expect(doc.instance(i.id).transform.scale[1]).toBeCloseTo(0.2, 9);
    expect(doc.instance(i.id).transform.scale[2]).toBe(0.001); // 0.0004 → clamp
    expect(doc.history.length).toBe(lenBefore + 1);
    doc.history.undo();
    expect(doc.instance(i.id).transform.scale).toEqual([1, 2, 0.004]);
  });

  it('统一锁 + 混合值:输入百分比作为绝对目标统一应用(PANEL 边界 3)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    doc.beginInteraction('缩放', [i2.id]);
    doc.updateInteraction((d) => (d.instance(i2.id).transform.scale = [3, 1, 2]));
    doc.commitInteraction();

    doc.setUniformScale([i1.id, i2.id], 1.5); // 150% 绝对目标
    for (const id of [i1.id, i2.id]) {
      expect(doc.instance(id).transform.scale).toEqual([1.5, 1.5, 1.5]);
    }
  });

  it('负数与超小值一律钳到 0.001(禁负,镜像为显式操作)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    doc.setTransformFieldMulti([i.id], 'scale', 0, -2);
    expect(doc.instance(i.id).transform.scale[0]).toBe(0.001);
    t += 1000;
    doc.setTransformFieldMulti([i.id], 'scale', 1, 0.0005);
    expect(doc.instance(i.id).transform.scale[1]).toBe(0.001);
  });
});

describe('PANEL-07 + 边界 1 材质', () => {
  it('多选含 1 个随组锁定成员改颜色:仅未锁定生效、历史 1 条、撤销同步还原(验收样例 3,C7 等效锁定口径)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const i3 = doc.placeInstance(a.id);
    const g = doc.group([i3.id]);
    doc.setLocked([g.id], true); // i3 自身未锁,但随组等效锁定
    const lenBefore = doc.history.length;

    const { skipped } = doc.setMaterialParam([i1.id, i2.id, i3.id], 'color', '#ff0000');
    expect(skipped).toBe(1);
    expect(doc.history.length).toBe(lenBefore + 1);
    expect(doc.instance(i1.id).materialOverride).toEqual({ color: '#ff0000' });
    expect(doc.instance(i3.id).materialOverride).toBeUndefined();

    doc.history.undo();
    expect(doc.instance(i1.id).materialOverride).toBeUndefined();
    expect(doc.instance(i2.id).materialOverride).toBeUndefined();
  });

  it('逐参数覆盖为合并写入:改粗糙度不清空已设颜色(C2 实例级覆盖)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    doc.setMaterialParam([i.id], 'color', '#00ff00');
    t += 1000;
    doc.setMaterialParam([i.id], 'roughness', 0.8);
    expect(doc.instance(i.id).materialOverride).toEqual({ color: '#00ff00', roughness: 0.8 });
  });

  it('滑杆 = 交互会话:任意次 update 收口为 1 条记录(C1 第二类)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i = doc.placeInstance(a.id);
    const lenBefore = doc.history.length;
    doc.beginInteraction('粗糙度', [i.id]);
    for (let k = 0; k <= 40; k++) {
      doc.updateInteraction((d) => {
        d.instance(i.id).materialOverride = { roughness: k / 40 };
      });
    }
    doc.commitInteraction();
    expect(doc.history.length).toBe(lenBefore + 1);
    expect(doc.instance(i.id).materialOverride).toEqual({ roughness: 1 });
    doc.history.undo();
    expect(doc.instance(i.id).materialOverride).toBeUndefined();
  });
});

describe('panel-logic 纯函数', () => {
  it('panelTargets:组展开为成员、去重、锁定进 N 计数(裁决 1)', () => {
    const doc = makeDoc();
    const a = doc.addAsset(anyAsset());
    const i1 = doc.placeInstance(a.id);
    const i2 = doc.placeInstance(a.id);
    const i3 = doc.placeInstance(a.id);
    const g = doc.group([i1.id, i2.id]);
    doc.setLocked([i2.id], true);
    doc.select([g.id, i1.id, i3.id]); // 组 + 组内成员重复 + 散件

    const pt = panelTargets(doc);
    expect(pt.all.map((n) => n.id).sort()).toEqual([i1.id, i2.id, i3.id].sort());
    expect(pt.editable.map((n) => n.id).sort()).toEqual([i1.id, i3.id].sort());
    expect(pt.lockedCount).toBe(1);
  });

  it('commonValue 混合检测与容差;parseNumeric 严格解析;stepDelta 三档步进(PANEL-05/06)', () => {
    expect(commonValue([1, 1 + 1e-9, 1])).toBe(1);
    expect(commonValue([1, 2])).toBeNull();
    expect(commonValue([])).toBeNull();

    expect(parseNumeric(' -12.5 ')).toBe(-12.5);
    expect(parseNumeric('3,5')).toBe(3.5); // 小数逗号容忍
    expect(parseNumeric('1e3')).toBeNull(); // 科学计数不收
    expect(parseNumeric('abc')).toBeNull();
    expect(parseNumeric('')).toBeNull();

    expect(stepDelta({ shiftKey: false, altKey: false }, 1)).toBe(1);
    expect(stepDelta({ shiftKey: true, altKey: false }, -1)).toBe(-10);
    expect(stepDelta({ shiftKey: false, altKey: true }, 1)).toBeCloseTo(0.1, 9);
  });

  it('mm↔% 双向换算:本体尺寸与旋转无关;退化轴返回 null 只读(裁决 2)', () => {
    expect(localSizeMm([10, 10, 10], [1.5, 1, 0.5])).toEqual([15, 10, 5]);
    expect(scaleFromSizeMm(10, 25)).toBe(2.5);
    expect(scaleFromSizeMm(0, 25)).toBeNull();
  });
});
