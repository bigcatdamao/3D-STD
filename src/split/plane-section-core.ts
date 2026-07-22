import * as THREE from 'three';
import type { Transform, Vec3 } from '../kernel/types';

export const DEFAULT_SECTION_FACE_BUDGET = 120_000;
export const MAX_SECTION_SEGMENTS = 24_000;

export interface PlaneSectionSegment {
  a: Vec3;
  b: Vec3;
}

export interface PlaneSectionAnalysis {
  status: 'closed' | 'open' | 'empty' | 'partial' | 'ambiguous';
  complete: boolean;
  facesTotal: number;
  facesTested: number;
  segmentCount: number;
  loopCount: number;
  openChainCount: number;
  branchPointCount: number;
  coplanarFaceCount: number;
  perimeterMm: number;
  areaMm2: number | null;
  segments: PlaneSectionSegment[];
  warnings: string[];
}

export interface PlaneSectionInput {
  positions: ArrayLike<number>;
  index?: ArrayLike<number> | null;
  transform: Transform;
  axisIndex: 0 | 1 | 2;
  positionMm: number;
  faceBudget?: number;
  segmentBudget?: number;
}

function transformMatrix(transform: Transform): readonly number[] {
  const D2R = Math.PI / 180;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      transform.rotation[0] * D2R,
      transform.rotation[1] * D2R,
      transform.rotation[2] * D2R,
      'XYZ',
    )),
    new THREE.Vector3(...transform.scale),
  ).elements;
}

function worldVertex(positions: ArrayLike<number>, vertexIndex: number, matrix: readonly number[]): Vec3 | null {
  const offset = vertexIndex * 3;
  const x = Number(positions[offset]);
  const y = Number(positions[offset + 1]);
  const z = Number(positions[offset + 2]);
  if (![x, y, z].every(Number.isFinite)) return null;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function squaredDistance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function interpolate(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function pointKey(point: Vec3, epsilon: number): string {
  return `${Math.round(point[0] / epsilon)},${Math.round(point[1] / epsilon)},${Math.round(point[2] / epsilon)}`;
}

function segmentOfTriangle(points: [Vec3, Vec3, Vec3], distances: [number, number, number], epsilon: number): PlaneSectionSegment | null {
  const candidates: Vec3[] = [];
  const addUnique = (point: Vec3) => {
    if (!candidates.some((other) => squaredDistance(point, other) <= epsilon * epsilon)) candidates.push(point);
  };
  for (let index = 0; index < 3; index += 1) {
    if (Math.abs(distances[index]) <= epsilon) addUnique(points[index]);
  }
  const edges = [[0, 1], [1, 2], [2, 0]] as const;
  for (const [from, to] of edges) {
    const da = distances[from];
    const db = distances[to];
    if ((da < -epsilon && db > epsilon) || (da > epsilon && db < -epsilon)) {
      addUnique(interpolate(points[from], points[to], da / (da - db)));
    }
  }
  if (candidates.length < 2) return null;
  let best: PlaneSectionSegment | null = null;
  let bestDistance = 0;
  for (let a = 0; a < candidates.length - 1; a += 1) {
    for (let b = a + 1; b < candidates.length; b += 1) {
      const distance = squaredDistance(candidates[a], candidates[b]);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = { a: candidates[a], b: candidates[b] };
      }
    }
  }
  return bestDistance > epsilon * epsilon ? best : null;
}

function polygonArea(loop: Vec3[], axes: readonly [number, number]): number {
  let twiceArea = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const current = loop[index];
    const next = loop[(index + 1) % loop.length];
    twiceArea += current[axes[0]] * next[axes[1]] - next[axes[0]] * current[axes[1]];
  }
  return Math.abs(twiceArea) / 2;
}

function pointInPolygon(point: Vec3, polygon: Vec3[], axes: readonly [number, number]): boolean {
  const x = point[axes[0]];
  const y = point[axes[1]];
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const xi = polygon[current][axes[0]];
    const yi = polygon[current][axes[1]];
    const xj = polygon[previous][axes[0]];
    const yj = polygon[previous][axes[1]];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function netLoopArea(loops: Vec3[][], axisIndex: 0 | 1 | 2): number {
  const axes = ([0, 1, 2] as const).filter((axis) => axis !== axisIndex) as unknown as readonly [number, number];
  const areas = loops.map((loop) => polygonArea(loop, axes));
  return Math.max(0, loops.reduce((sum, loop, index) => {
    const depth = loops.reduce((count, other, otherIndex) => (
      otherIndex !== index && pointInPolygon(loop[0], other, axes) ? count + 1 : count
    ), 0);
    return sum + areas[index] * (depth % 2 === 0 ? 1 : -1);
  }, 0));
}

/**
 * 在世界坐标中求三角网格与轴向平面的真实相交线。
 * 只有完整扫描且所有线段组成无分叉闭合环时才返回面积；其余状态 fail-closed。
 */
export function analyzePlaneSection(input: PlaneSectionInput): PlaneSectionAnalysis {
  const vertexCount = Math.floor(input.positions.length / 3);
  const facesTotal = input.index
    ? Math.floor(input.index.length / 3)
    : Math.floor(vertexCount / 3);
  const faceBudget = Math.max(1, Math.floor(input.faceBudget ?? DEFAULT_SECTION_FACE_BUDGET));
  const segmentBudget = Math.max(1, Math.floor(input.segmentBudget ?? MAX_SECTION_SEGMENTS));
  const facesTested = Math.min(facesTotal, faceBudget);
  const matrix = transformMatrix(input.transform);
  const scale = Math.max(
    Math.abs(input.transform.scale[0]),
    Math.abs(input.transform.scale[1]),
    Math.abs(input.transform.scale[2]),
    1,
  );
  const epsilon = Math.max(1e-5, scale * 1e-5);
  const points = new Map<string, Vec3>();
  const uniqueSegments = new Map<string, [string, string]>();
  let coplanarFaceCount = 0;
  let segmentsTruncated = false;

  for (let sample = 0; sample < facesTested; sample += 1) {
    const face = facesTotal <= faceBudget ? sample : Math.floor((sample * facesTotal) / facesTested);
    const indices = [0, 1, 2].map((corner) => (
      input.index ? Number(input.index[face * 3 + corner]) : face * 3 + corner
    ));
    if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) continue;
    const vertices = indices.map((index) => worldVertex(input.positions, index, matrix));
    if (vertices.some((vertex) => !vertex)) continue;
    const triangle = vertices as [Vec3, Vec3, Vec3];
    const distances = triangle.map((point) => point[input.axisIndex] - input.positionMm) as [number, number, number];
    if (distances.every((distance) => Math.abs(distance) <= epsilon)) {
      coplanarFaceCount += 1;
      continue;
    }
    if (distances.every((distance) => distance > epsilon) || distances.every((distance) => distance < -epsilon)) continue;
    const segment = segmentOfTriangle(triangle, distances, epsilon);
    if (!segment) continue;
    const keyA = pointKey(segment.a, epsilon);
    const keyB = pointKey(segment.b, epsilon);
    if (keyA === keyB) continue;
    const segmentKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
    if (uniqueSegments.has(segmentKey)) continue;
    if (uniqueSegments.size >= segmentBudget) {
      segmentsTruncated = true;
      break;
    }
    points.set(keyA, points.get(keyA) ?? segment.a);
    points.set(keyB, points.get(keyB) ?? segment.b);
    uniqueSegments.set(segmentKey, [keyA, keyB]);
  }

  const adjacency = new Map<string, Set<string>>();
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const [a, b] of uniqueSegments.values()) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  }

  const visitedNodes = new Set<string>();
  const visitedEdges = new Set<string>();
  const loops: Vec3[][] = [];
  let openChainCount = 0;
  let branchPointCount = 0;

  for (const start of adjacency.keys()) {
    if (visitedNodes.has(start)) continue;
    const stack = [start];
    const component: string[] = [];
    visitedNodes.add(start);
    while (stack.length) {
      const node = stack.pop()!;
      component.push(node);
      for (const neighbor of adjacency.get(node) ?? []) {
        if (!visitedNodes.has(neighbor)) {
          visitedNodes.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    const branches = component.filter((node) => (adjacency.get(node)?.size ?? 0) > 2).length;
    branchPointCount += branches;
    const closedComponent = component.length >= 3 && branches === 0
      && component.every((node) => adjacency.get(node)?.size === 2);
    if (!closedComponent) {
      openChainCount += 1;
      continue;
    }
    const loopKeys: string[] = [start];
    let previous: string | null = null;
    let current = start;
    while (true) {
      const neighbors = [...(adjacency.get(current) ?? [])];
      const next = neighbors.find((neighbor) => neighbor !== previous && !visitedEdges.has(edgeKey(current, neighbor)))
        ?? neighbors.find((neighbor) => neighbor !== previous);
      if (!next) break;
      visitedEdges.add(edgeKey(current, next));
      if (next === start) break;
      loopKeys.push(next);
      previous = current;
      current = next;
      if (loopKeys.length > component.length + 1) break;
    }
    if (loopKeys.length === component.length) loops.push(loopKeys.map((key) => points.get(key)!));
    else openChainCount += 1;
  }

  const complete = facesTested === facesTotal && !segmentsTruncated;
  const segments = [...uniqueSegments.values()].map(([a, b]) => ({ a: points.get(a)!, b: points.get(b)! }));
  const perimeterMm = segments.reduce((sum, segment) => sum + Math.sqrt(squaredDistance(segment.a, segment.b)), 0);
  const closed = complete
    && segments.length > 0
    && openChainCount === 0
    && branchPointCount === 0
    && coplanarFaceCount === 0
    && loops.length > 0;
  const status: PlaneSectionAnalysis['status'] = !complete
    ? 'partial'
    : segments.length === 0
      ? 'empty'
      : coplanarFaceCount > 0 || branchPointCount > 0
        ? 'ambiguous'
        : openChainCount > 0
          ? 'open'
          : 'closed';
  const warnings: string[] = [];
  if (!complete) warnings.push(`仅分析 ${facesTested.toLocaleString()} / ${facesTotal.toLocaleString()} 面，轮廓与面积不下结论`);
  if (segmentsTruncated) warnings.push(`截面线段超过 ${segmentBudget.toLocaleString()} 条预算`);
  if (coplanarFaceCount > 0) warnings.push(`${coplanarFaceCount.toLocaleString()} 个三角形与切面共面，截面存在歧义`);
  if (branchPointCount > 0) warnings.push(`${branchPointCount.toLocaleString()} 个轮廓分叉点，无法形成简单闭合环`);
  if (openChainCount > 0 && complete) warnings.push(`${openChainCount.toLocaleString()} 组轮廓未闭合，面积不可用`);
  if (segments.length === 0 && complete) warnings.push('当前平面未与三角网格形成有效截线');

  return {
    status,
    complete,
    facesTotal,
    facesTested,
    segmentCount: segments.length,
    loopCount: loops.length,
    openChainCount,
    branchPointCount,
    coplanarFaceCount,
    perimeterMm,
    areaMm2: closed ? netLoopArea(loops, input.axisIndex) : null,
    segments,
    warnings,
  };
}
