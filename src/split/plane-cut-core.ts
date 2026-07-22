import type { Vec3 } from '../kernel/types';
import type { BedConfig } from '../state/store';

export type CutAxis = 'x' | 'y' | 'z';

export interface WorldBounds {
  min: Vec3;
  max: Vec3;
}

export interface PlaneCutPartEstimate {
  label: 'A' | 'B';
  bounds: WorldBounds;
  dimensionsMm: Vec3;
  fitsBed: boolean;
}

export interface PlaneCutCandidate {
  id: string;
  axis: CutAxis;
  axisIndex: 0 | 1 | 2;
  positionMm: number;
  normalizedPosition: number;
  label: string;
  rationale: string;
  score: number;
  cutAreaEstimateMm2: number;
  parts: [PlaneCutPartEstimate, PlaneCutPartEstimate];
  fitsBedAfter: boolean;
  feasiblePositionRange: [number, number] | null;
  remainingOverflowAxes: CutAxis[];
  limitations: string[];
}

const AXES: { axis: CutAxis; index: 0 | 1 | 2 }[] = [
  { axis: 'x', index: 0 },
  { axis: 'y', index: 1 },
  { axis: 'z', index: 2 },
];

export function dimensionsOf(bounds: WorldBounds): Vec3 {
  return [
    Math.max(0, bounds.max[0] - bounds.min[0]),
    Math.max(0, bounds.max[1] - bounds.min[1]),
    Math.max(0, bounds.max[2] - bounds.min[2]),
  ];
}

export function dimensionsFitBed(dimensions: Vec3, bed: BedConfig): boolean {
  return dimensions[0] <= bed.x + 0.05
    && dimensions[1] <= bed.y + 0.05
    && dimensions[2] <= bed.z + 0.05;
}

function splitBounds(bounds: WorldBounds, axis: 0 | 1 | 2, position: number): [WorldBounds, WorldBounds] {
  const a: WorldBounds = { min: [...bounds.min] as Vec3, max: [...bounds.max] as Vec3 };
  const b: WorldBounds = { min: [...bounds.min] as Vec3, max: [...bounds.max] as Vec3 };
  a.max[axis] = position;
  b.min[axis] = position;
  return [a, b];
}

function feasiblePositionRange(
  dimensions: Vec3,
  bedDimensions: Vec3,
  axisIndex: 0 | 1 | 2,
): [number, number] | null {
  const otherAxes = ([0, 1, 2] as const).filter((axis) => axis !== axisIndex);
  if (otherAxes.some((axis) => dimensions[axis] > bedDimensions[axis] + 0.05)) return null;
  const length = Math.max(dimensions[axisIndex], 0.001);
  const capacity = bedDimensions[axisIndex];
  if (length > capacity * 2 + 0.05) return null;
  return [Math.max(0, 1 - capacity / length), Math.min(1, capacity / length)];
}

/**
 * 评估一个轴向切面位置。位置限定在 10%–90%，避免产生无法观察或操作的近零薄片。
 */
export function evaluatePlaneCutCandidate(
  bounds: WorldBounds,
  bed: BedConfig,
  axis: CutAxis,
  requestedPosition: number,
): PlaneCutCandidate {
  const axisInfo = AXES.find((candidate) => candidate.axis === axis)!;
  const { index } = axisInfo;
  const normalizedPosition = Math.max(0.1, Math.min(0.9, requestedPosition));
  const originalDimensions = dimensionsOf(bounds);
  const bedDimensions: Vec3 = [bed.x, bed.y, bed.z];
  const originalOverflow = AXES.filter(({ index: candidateIndex }) =>
    originalDimensions[candidateIndex] > bedDimensions[candidateIndex] + 0.05,
  ).map(({ axis: overflowAxis }) => overflowAxis);
  const longest = Math.max(...originalDimensions, 0.001);
  const positionMm = bounds.min[index] + originalDimensions[index] * normalizedPosition;
  const [aBounds, bBounds] = splitBounds(bounds, index, positionMm);
  const aDimensions = dimensionsOf(aBounds);
  const bDimensions = dimensionsOf(bBounds);
  const aFits = dimensionsFitBed(aDimensions, bed);
  const bFits = dimensionsFitBed(bDimensions, bed);
  const parts: [PlaneCutPartEstimate, PlaneCutPartEstimate] = [
    { label: 'A', bounds: aBounds, dimensionsMm: aDimensions, fitsBed: aFits },
    { label: 'B', bounds: bBounds, dimensionsMm: bDimensions, fitsBed: bFits },
  ];
  const remainingOverflowAxes = AXES.filter(({ index: other }) =>
    aDimensions[other] > bedDimensions[other] + 0.05
    || bDimensions[other] > bedDimensions[other] + 0.05,
  ).map(({ axis: otherAxis }) => otherAxis);
  const otherAxes = ([0, 1, 2] as const).filter((other) => other !== index);
  const cutAreaEstimateMm2 = originalDimensions[otherAxes[0]] * originalDimensions[otherAxes[1]];
  const cutsOverflowAxis = originalOverflow.includes(axis);
  const fitsBedAfter = aFits && bFits;
  const balance = 1 - Math.abs(normalizedPosition - 0.5) * 2;
  const score = Math.max(0, Math.min(100, Math.round(
    (fitsBedAfter ? 55 : 0)
    + (cutsOverflowAxis ? 25 : 0)
    + (originalDimensions[index] / longest) * 15
    + balance * 5
    - (cutAreaEstimateMm2 / Math.max(originalDimensions[0] * originalDimensions[1], 1)) * 0.01,
  )));
  const percent = Math.round(normalizedPosition * 100);
  const label = normalizedPosition === 0.5 ? `${axis.toUpperCase()} 中线` : `${axis.toUpperCase()} 轴 ${percent}%`;
  const rationale = fitsBedAfter
    ? `沿 ${axis.toUpperCase()} 轴 ${percent}% 位置切分后，两侧按当前朝向均可放入打印床`
    : cutsOverflowAxis
      ? `沿 ${axis.toUpperCase()} 轴 ${percent}% 位置切分后，至少一侧仍超过打印床`
      : `用于比较 ${axis.toUpperCase()} 轴 ${percent}% 切面；不会消除其他轴的超床问题`;

  return {
    id: `${axis}-${percent}`,
    axis,
    axisIndex: index,
    positionMm,
    normalizedPosition,
    label,
    rationale,
    score,
    cutAreaEstimateMm2,
    parts,
    fitsBedAfter,
    feasiblePositionRange: feasiblePositionRange(originalDimensions, bedDimensions, index),
    remainingOverflowAxes,
    limitations: [
      '两侧尺寸来自世界包围盒估算，不代表精确切后体积',
      '未计算真实截面、封口、壁厚、连接结构与装配公差',
    ],
  };
}

/**
 * 为单一连通壳生成三个可重复的轴向中线候选。
 * 这里只切世界 AABB 并估算两侧尺寸，不计算真实截面、不封口，也不创建派生几何。
 */
export function findPlaneCutCandidates(bounds: WorldBounds, bed: BedConfig): PlaneCutCandidate[] {
  return AXES.map(({ axis }) => evaluatePlaneCutCandidate(bounds, bed, axis, 0.5))
    .sort((a, b) => b.score - a.score || a.axisIndex - b.axisIndex);
}
