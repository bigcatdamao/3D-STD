// 参数面板纯逻辑层(T8)—— 与 tree-logic/gizmo-math 同责:一切可测的派生与换算收敛到纯函数。
//
// 记录在案的裁决(PRD 注释层素材):
// 1. 面板目标集 = 选中集展开后的实例集合,与视口 gizmo 同一口径:显示与编辑均基于「可编辑成员」
//    (剔除 C7 等效锁定);锁定成员只进 N 计数(PANEL 边界 1)。选中一个组 = 对其成员的多选编辑
//    —— 组本身无变换数据,与 gizmo 枢轴行为一致(可预测,信条 4)。可编辑集为空时全字段只读。
// 2. 「尺寸 mm」= 本体尺寸(资产 bbox 跨度 × 缩放),与旋转无关 —— 若取世界包围盒,旋转会使
//    mm↔% 双向换算不可逆(信条 4)。世界包围盒尺寸在「对象信息」中另行展示。
// 3. 统一缩放锁语义分两支:被编辑轴有共同值 → 等比系数(保持成员间/轴间比例,对齐切片软件,
//    信条 1);被编辑轴为混合值 → 绝对目标统一应用(PANEL 边界 3 明文)。

import { SceneDocument } from '../kernel/scene';
import { InstanceNode, Vec3 } from '../kernel/types';
import { selectionBBox } from '../viewport/gizmo-math';

export const EPS = 1e-6;

export interface PanelTargets {
  all: InstanceNode[]; // 选中集展开后的全部实例(含锁定)
  editable: InstanceNode[]; // 剔除等效锁定后的可编辑集
  lockedCount: number; // PANEL 边界 1 的 N
}

/** 选中集 → 面板目标集(裁决 1)。组展开为其全部后代实例;去重;隐藏对象可编辑(C7 只约束渲染/检查/导出)。 */
export function panelTargets(doc: SceneDocument): PanelTargets {
  const all = new Map<string, InstanceNode>();
  for (const id of doc.selection) {
    const n = doc.nodes.get(id);
    if (!n) continue;
    const pool = n.kind === 'instance' ? [n.id] : doc.descendants(n.id);
    for (const pid of pool) {
      const p = doc.nodes.get(pid);
      if (p && p.kind === 'instance') all.set(p.id, p);
    }
  }
  const allArr = [...all.values()];
  const editable = allArr.filter((n) => !doc.effectiveLocked(n.id));
  return { all: allArr, editable, lockedCount: allArr.length - editable.length };
}

/** 共同值:全体相等(±eps)返回该值,否则 null =「多值」占位(PANEL-03) */
export function commonValue(vals: number[], eps = EPS): number | null {
  if (!vals.length) return null;
  const v0 = vals[0];
  return vals.every((v) => Math.abs(v - v0) <= eps) ? v0 : null;
}

/** 字符串共同值(材质颜色用):全体一致返回该值,否则 null */
export function commonString(vals: string[]): string | null {
  if (!vals.length) return null;
  return vals.every((v) => v === vals[0]) ? vals[0] : null;
}

/** 目标集世界包围盒(位置显示 = 其中心,PANEL-03;口径与 gizmo 枢轴一致) */
export function targetsBBox(
  doc: SceneDocument,
  targets: InstanceNode[],
): { min: Vec3; max: Vec3; center: Vec3; size: Vec3 } | null {
  const items = targets
    .map((n) => {
      const a = doc.assets.get(n.assetId);
      return a ? { transform: n.transform, bbox: a.meta.bbox } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!items.length) return null;
  const box = selectionBBox(items);
  if (!box) return null;
  const min: Vec3 = [box.min.x, box.min.y, box.min.z];
  const max: Vec3 = [box.max.x, box.max.y, box.max.z];
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/** 资产本体跨度(local bbox extent,mm) */
export function assetExtent(doc: SceneDocument, inst: InstanceNode): Vec3 | null {
  const a = doc.assets.get(inst.assetId);
  if (!a) return null;
  const { min, max } = a.meta.bbox;
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/** 本体尺寸 mm = 跨度 × |缩放|(裁决 2:与旋转无关) */
export function localSizeMm(extent: Vec3, scale: Vec3): Vec3 {
  return [
    extent[0] * Math.abs(scale[0]),
    extent[1] * Math.abs(scale[1]),
    extent[2] * Math.abs(scale[2]),
  ];
}

/** mm → 缩放分量;退化轴(跨度≈0)返回 null,该轴尺寸只读 */
export function scaleFromSizeMm(extentAxis: number, mm: number): number | null {
  if (extentAxis <= EPS) return null;
  return mm / extentAxis;
}

/** PANEL-06 步进:方向键 ±1,Shift ±10,Alt ±0.1 */
export function stepDelta(mods: { shiftKey: boolean; altKey: boolean }, dir: 1 | -1): number {
  const mag = mods.altKey ? 0.1 : mods.shiftKey ? 10 : 1;
  return mag * dir;
}

/** 严格十进制解析(允许负号/小数);非法返回 null → 失焦还原(PANEL-05) */
export function parseNumeric(s: string): number | null {
  const t = s.trim().replace(',', '.'); // 容忍小数逗号(中文输入法切换常见)
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** PANEL-05 显示口径:2 位小数;存储全精度、舍入不回写由 NumberField 的全精度草稿保证 */
export const fmt2 = (v: number) => v.toFixed(2);

/** PANEL 边界 2 的目标签名:编辑期间选中集变化(签名不等)→ 提交丢弃、不报错 */
export function targetsSig(targets: InstanceNode[]): string {
  return targets
    .map((n) => n.id)
    .sort()
    .join('+');
}
