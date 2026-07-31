import type { Vec3 } from '../kernel/types';

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function pointSegmentDistance(point: Vec3, start: Vec3, end: Vec3): number {
  const ab: Vec3 = [
    end[0] - start[0],
    end[1] - start[1],
    end[2] - start[2],
  ];
  const ap: Vec3 = [
    point[0] - start[0],
    point[1] - start[1],
    point[2] - start[2],
  ];
  const denominator = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = denominator > 1e-12
    ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / denominator))
    : 0;
  return Math.hypot(
    point[0] - (start[0] + ab[0] * t),
    point[1] - (start[1] + ab[1] * t),
    point[2] - (start[2] + ab[2] * t),
  );
}

function simplifyRange(
  points: Vec3[],
  start: number,
  end: number,
  toleranceMm: number,
  keep: Uint8Array,
): void {
  let farthest = -1;
  let farthestDistance = toleranceMm;
  for (let index = start + 1; index < end; index += 1) {
    const currentDistance = pointSegmentDistance(points[index], points[start], points[end]);
    if (currentDistance <= farthestDistance) continue;
    farthestDistance = currentDistance;
    farthest = index;
  }
  if (farthest < 0) return;
  keep[farthest] = 1;
  simplifyRange(points, start, farthest, toleranceMm, keep);
  simplifyRange(points, farthest, end, toleranceMm, keep);
}

export function surfaceStrokeLength(points: readonly Vec3[], closed = false): number {
  if (points.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += distance(points[index - 1], points[index]);
  }
  if (closed && points.length > 2) length += distance(points[points.length - 1], points[0]);
  return length;
}

export function surfaceStrokeClosureGap(points: readonly Vec3[]): number {
  return points.length > 1 ? distance(points[0], points[points.length - 1]) : 0;
}

export function simplifySurfaceStroke(
  source: readonly Vec3[],
  toleranceMm: number,
  maxPoints = 64,
): Vec3[] {
  const pointBudget = Math.max(2, Math.floor(maxPoints));
  const finite = source
    .filter((point) => point.length === 3 && point.every(Number.isFinite))
    .map((point) => [...point] as Vec3);
  if (finite.length <= 2) return finite;
  const keep = new Uint8Array(finite.length);
  keep[0] = 1;
  keep[finite.length - 1] = 1;
  simplifyRange(finite, 0, finite.length - 1, Math.max(0, toleranceMm), keep);
  let simplified = finite.filter((_, index) => keep[index]);
  if (simplified.length <= pointBudget) return simplified;
  const sampled: Vec3[] = [];
  for (let index = 0; index < pointBudget; index += 1) {
    const sourceIndex = Math.round((index / (pointBudget - 1)) * (simplified.length - 1));
    sampled.push(simplified[sourceIndex]);
  }
  simplified = sampled;
  return simplified;
}
