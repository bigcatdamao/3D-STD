// 单位推断置信度分级(IMP-05)—— 纯逻辑,无 UI 依赖。
// 规则:包围盒最大边 L∈[10,400](文件原始单位数值)→ 静默按 mm + 可撤 toast;
//       否则弹单位确认(mm/cm/inch/m,床上实时预览);glTF 按规范米→mm 直换不询问(在解码阶段已烘焙)。

export type UnitChoice = 'mm' | 'cm' | 'inch' | 'm';

export const UNIT_FACTOR: Record<UnitChoice, number> = {
  mm: 1,
  cm: 10,
  inch: 25.4,
  m: 1000,
};

export const UNIT_LABEL: Record<UnitChoice, string> = {
  mm: '毫米 mm',
  cm: '厘米 cm',
  inch: '英寸 inch',
  m: '米 m',
};

export const SILENT_MIN = 10;
export const SILENT_MAX = 400;

export type UnitDecision =
  | { kind: 'silent-mm' } // 置信区间内:静默按 mm,toast 告知且可改
  | { kind: 'ask'; recommended: UnitChoice }; // 区间外:弹确认,recommended 为落床后最合理的候选

/** 推荐排序依据:换算成 mm 后最大边落入 [10,400] 者优先;都不落入则取与区间距离最近者。
 *  并列时按 mm → cm → inch → m 的常见度顺序取先。 */
export function inferUnit(maxEdgeRaw: number): UnitDecision {
  if (maxEdgeRaw >= SILENT_MIN && maxEdgeRaw <= SILENT_MAX) return { kind: 'silent-mm' };
  const order: UnitChoice[] = ['mm', 'cm', 'inch', 'm'];
  let best: UnitChoice = 'mm';
  let bestScore = Infinity;
  for (const u of order) {
    const L = maxEdgeRaw * UNIT_FACTOR[u];
    const dist = L < SILENT_MIN ? SILENT_MIN - L : L > SILENT_MAX ? L - SILENT_MAX : 0;
    if (dist < bestScore) {
      bestScore = dist;
      best = u;
    }
  }
  return { kind: 'ask', recommended: best };
}

/** 单位确认对话框的尺寸预览文案:各单位换算后的落床毫米尺寸 */
export function sizeInMm(
  bboxRaw: { min: [number, number, number]; max: [number, number, number] },
  unit: UnitChoice,
): [number, number, number] {
  const f = UNIT_FACTOR[unit];
  return [
    (bboxRaw.max[0] - bboxRaw.min[0]) * f,
    (bboxRaw.max[1] - bboxRaw.min[1]) * f,
    (bboxRaw.max[2] - bboxRaw.min[2]) * f,
  ];
}

export function fmtMm(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2);
}
