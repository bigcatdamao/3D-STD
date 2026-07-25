import * as THREE from 'three';
import type { Transform, Vec3 } from '../kernel/types';

export const SURFACE_CUT_FACE_BUDGET = 80_000;
export const SURFACE_CUT_BOUNDARY_BUDGET = 12_000;
export const SURFACE_CUT_CAP_CONTOUR_BUDGET = 4_096;
export type SurfaceCutPreference = 'balanced' | 'shortest' | 'crease';

export interface SurfaceCutInput {
  positions: ArrayLike<number>;
  index?: ArrayLike<number> | null;
  transform: Transform;
  /** M1.7.8 兼容入口；新交互使用任意世界引导平面。 */
  axisIndex?: 0 | 1 | 2;
  guidePositionMm?: number;
  guideOriginWorld?: Vec3;
  guideNormalWorld?: Vec3;
  searchHalfWidthMm: number;
  preference?: SurfaceCutPreference;
  maxCapWarpRatio?: number;
  faceBudget?: number;
  boundaryBudget?: number;
}

export interface SurfaceCutPart {
  positions: Float32Array;
  sourceFaceCount: number;
  capFaceCount: number;
  boundaryEdges: number;
  dimensionsMm: Vec3;
}

export interface SurfaceCutMetrics {
  sourceFaces: number;
  partAFaces: number;
  partBFaces: number;
  boundaryVertices: number;
  seamLengthMm: number;
  guideOffsetMm: number;
  adaptiveSpanMm: number;
  meanCreaseDeg: number;
  searchHalfWidthMm: number;
  maxCapDeviationMm: number;
  capWarpRatio: number;
  preference: SurfaceCutPreference;
}

export type SurfaceCutResult =
  | {
    status: 'ready';
    partA: SurfaceCutPart;
    partB: SurfaceCutPart;
    seamPositions: Float32Array;
    metrics: SurfaceCutMetrics;
    warnings: string[];
  }
  | {
    status: 'unsupported';
    code:
      | 'budget'
      | 'invalid_geometry'
      | 'non_manifold_source'
      | 'missing_seeds'
      | 'branching_seam'
      | 'multiple_seams'
      | 'boundary_budget'
      | 'self_intersecting_seam'
      | 'cap_too_warped'
      | 'cap_failed';
    message: string;
    details?: Record<string, number>;
  };

interface Face {
  original: [number, number, number];
  welded: [number, number, number];
  normalWorld: Vec3;
  centroidGuide: number;
  areaWorld: number;
}

interface ResolvedGuide {
  origin: Vec3;
  normal: Vec3;
}

interface CapTriangulation {
  triangles: [number, number, number][];
  maxDeviationMm: number;
  warpRatio: number;
}

interface EdgeUse {
  face: number;
  from: number;
  to: number;
}

interface MeshEdge {
  a: number;
  b: number;
  uses: EdgeUse[];
}

interface PairCost {
  edge: MeshEdge;
  faceA: number;
  faceB: number;
  capacity: number;
  creaseDeg: number;
}

interface FlowEdge {
  to: number;
  reverse: number;
  capacity: number;
}

class Dinic {
  private graph: FlowEdge[][];

  constructor(size: number) {
    this.graph = Array.from({ length: size }, () => []);
  }

  addDirected(from: number, to: number, capacity: number): void {
    const forward: FlowEdge = { to, reverse: this.graph[to].length, capacity };
    const reverse: FlowEdge = { to: from, reverse: this.graph[from].length, capacity: 0 };
    this.graph[from].push(forward);
    this.graph[to].push(reverse);
  }

  addPair(a: number, b: number, capacity: number): void {
    this.addDirected(a, b, capacity);
    this.addDirected(b, a, capacity);
  }

  maxFlow(source: number, sink: number): number {
    let flow = 0;
    const level = new Int32Array(this.graph.length);
    while (this.buildLevels(source, sink, level)) {
      const cursor = new Int32Array(this.graph.length);
      while (true) {
        const pushed = this.push(source, sink, Number.POSITIVE_INFINITY, level, cursor);
        if (pushed <= 1e-9) break;
        flow += pushed;
      }
    }
    return flow;
  }

  reachableFrom(source: number): Uint8Array {
    const seen = new Uint8Array(this.graph.length);
    const queue = [source];
    seen[source] = 1;
    for (let index = 0; index < queue.length; index += 1) {
      const node = queue[index];
      for (const edge of this.graph[node]) {
        if (edge.capacity > 1e-9 && !seen[edge.to]) {
          seen[edge.to] = 1;
          queue.push(edge.to);
        }
      }
    }
    return seen;
  }

  private buildLevels(source: number, sink: number, level: Int32Array): boolean {
    level.fill(-1);
    level[source] = 0;
    const queue = [source];
    for (let index = 0; index < queue.length; index += 1) {
      const node = queue[index];
      for (const edge of this.graph[node]) {
        if (edge.capacity > 1e-9 && level[edge.to] < 0) {
          level[edge.to] = level[node] + 1;
          queue.push(edge.to);
        }
      }
    }
    return level[sink] >= 0;
  }

  private push(
    node: number,
    sink: number,
    available: number,
    level: Int32Array,
    cursor: Int32Array,
  ): number {
    if (node === sink) return available;
    for (; cursor[node] < this.graph[node].length; cursor[node] += 1) {
      const edge = this.graph[node][cursor[node]];
      if (edge.capacity <= 1e-9 || level[edge.to] !== level[node] + 1) continue;
      const pushed = this.push(edge.to, sink, Math.min(available, edge.capacity), level, cursor);
      if (pushed <= 1e-9) continue;
      edge.capacity -= pushed;
      this.graph[edge.to][edge.reverse].capacity += pushed;
      return pushed;
    }
    return 0;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function localVertex(positions: ArrayLike<number>, index: number): Vec3 | null {
  const offset = index * 3;
  const point: Vec3 = [Number(positions[offset]), Number(positions[offset + 1]), Number(positions[offset + 2])];
  return point.every(Number.isFinite) ? point : null;
}

function transformMatrix(transform: Transform): THREE.Matrix4 {
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
  );
}

function applyMatrix(point: Vec3, matrix: THREE.Matrix4): Vec3 {
  const result = new THREE.Vector3(...point).applyMatrix4(matrix);
  return [result.x, result.y, result.z];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function distance(a: Vec3, b: Vec3): number {
  return length(subtract(a, b));
}

function normalize(vector: Vec3): Vec3 {
  const magnitude = length(vector);
  return magnitude > 1e-12
    ? [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude]
    : [0, 0, 0];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function median(values: number[]): number {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 1;
}

function dimensionsOfWorldTriangles(positions: Float32Array, matrix: THREE.Matrix4): Vec3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    const world = applyMatrix([positions[offset], positions[offset + 1], positions[offset + 2]], matrix);
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], world[axis]);
      max[axis] = Math.max(max[axis], world[axis]);
    }
  }
  return [0, 1, 2].map((axis) => Math.max(0, max[axis] - min[axis])) as Vec3;
}

function boundaryEdgeCount(positions: Float32Array, epsilon: number): number {
  const counts = new Map<string, number>();
  const keyOf = (offset: number) => [0, 1, 2]
    .map((axis) => Math.round(positions[offset + axis] / epsilon)).join(',');
  for (let offset = 0; offset < positions.length; offset += 9) {
    const vertices = [keyOf(offset), keyOf(offset + 3), keyOf(offset + 6)];
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
      const key = vertices[a] < vertices[b] ? `${vertices[a]}|${vertices[b]}` : `${vertices[b]}|${vertices[a]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.values()].filter((count) => count !== 2).length;
}

function finiteVec3(value: Vec3 | undefined): value is Vec3 {
  return !!value && value.length === 3 && value.every(Number.isFinite);
}

function resolveGuide(input: SurfaceCutInput): ResolvedGuide | null {
  if (finiteVec3(input.guideOriginWorld) && finiteVec3(input.guideNormalWorld)) {
    const normal = normalize(input.guideNormalWorld);
    return length(normal) > 1e-9
      ? { origin: [...input.guideOriginWorld] as Vec3, normal }
      : null;
  }
  if (
    input.axisIndex !== undefined
    && input.guidePositionMm !== undefined
    && Number.isFinite(input.guidePositionMm)
  ) {
    const origin: Vec3 = [0, 0, 0];
    const normal: Vec3 = [0, 0, 0];
    origin[input.axisIndex] = input.guidePositionMm;
    normal[input.axisIndex] = 1;
    return { origin, normal };
  }
  return null;
}

function signedGuideDistance(point: Vec3, guide: ResolvedGuide): number {
  return dot(subtract(point, guide.origin), guide.normal);
}

function preferencePenalty(preference: SurfaceCutPreference, smoothness: number): number {
  if (preference === 'shortest') return 0.72 + 0.58 * smoothness;
  if (preference === 'crease') return 0.08 + 4.92 * Math.pow(smoothness, 4);
  return 0.18 + 2.82 * Math.pow(smoothness, 3);
}

function signedArea2(points: THREE.Vector2[]): number {
  let area2 = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area2 += current.x * next.y - next.x * current.y;
  }
  return area2;
}

function orient2d(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment2d(a: THREE.Vector2, b: THREE.Vector2, point: THREE.Vector2, epsilon: number): boolean {
  return Math.abs(orient2d(a, b, point)) <= epsilon
    && point.x >= Math.min(a.x, b.x) - epsilon
    && point.x <= Math.max(a.x, b.x) + epsilon
    && point.y >= Math.min(a.y, b.y) - epsilon
    && point.y <= Math.max(a.y, b.y) + epsilon;
}

function segmentsIntersect2d(
  a: THREE.Vector2,
  b: THREE.Vector2,
  c: THREE.Vector2,
  d: THREE.Vector2,
  epsilon: number,
): boolean {
  const abC = orient2d(a, b, c);
  const abD = orient2d(a, b, d);
  const cdA = orient2d(c, d, a);
  const cdB = orient2d(c, d, b);
  if (
    ((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
    && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))
  ) return true;
  return onSegment2d(a, b, c, epsilon)
    || onSegment2d(a, b, d, epsilon)
    || onSegment2d(c, d, a, epsilon)
    || onSegment2d(c, d, b, epsilon);
}

function polygonSelfIntersects(points: THREE.Vector2[], epsilon: number): boolean {
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (
        first === second
        || firstNext === second
        || secondNext === first
        || (first === 0 && secondNext === 0)
      ) continue;
      if (segmentsIntersect2d(
        points[first],
        points[firstNext],
        points[second],
        points[secondNext],
        epsilon,
      )) return true;
    }
  }
  return false;
}

function newellNormal(points: Vec3[]): Vec3 {
  const normal: Vec3 = [0, 0, 0];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  return normalize(normal);
}

function triangulateCap(
  loop: number[],
  weldedWorld: Vec3[],
  maxWarpRatio: number,
): CapTriangulation | Extract<SurfaceCutResult, { status: 'unsupported' }> {
  if (loop.length > SURFACE_CUT_CAP_CONTOUR_BUDGET) {
    return {
      status: 'unsupported',
      code: 'boundary_budget',
      message: `接缝含 ${loop.length.toLocaleString()} 个顶点，超过可靠封口 ${SURFACE_CUT_CAP_CONTOUR_BUDGET.toLocaleString()} 点预算`,
      details: { boundaryVertices: loop.length, capContourBudget: SURFACE_CUT_CAP_CONTOUR_BUDGET },
    };
  }
  const world = loop.map((vertex) => weldedWorld[vertex]);
  const center = world.reduce<Vec3>((sum, point) => [
    sum[0] + point[0],
    sum[1] + point[1],
    sum[2] + point[2],
  ], [0, 0, 0]).map((value) => value / world.length) as Vec3;
  const planeNormal = newellNormal(world);
  if (length(planeNormal) <= 1e-9) {
    return {
      status: 'unsupported',
      code: 'cap_failed',
      message: '接缝无法建立稳定的封口投影平面',
    };
  }
  const helper: Vec3 = Math.abs(planeNormal[2]) < 0.82 ? [0, 0, 1] : [0, 1, 0];
  const tangent = normalize(cross(helper, planeNormal));
  const bitangent = normalize(cross(planeNormal, tangent));
  const contour = world.map((point) => {
    const relative = subtract(point, center);
    return new THREE.Vector2(dot(relative, tangent), dot(relative, bitangent));
  });
  const area2 = signedArea2(contour);
  const minX = Math.min(...contour.map((point) => point.x));
  const maxX = Math.max(...contour.map((point) => point.x));
  const minY = Math.min(...contour.map((point) => point.y));
  const maxY = Math.max(...contour.map((point) => point.y));
  const diagonal = Math.max(Math.hypot(maxX - minX, maxY - minY), 1e-6);
  const epsilon2d = Math.max(1e-7, diagonal * 1e-8);
  if (Math.abs(area2) <= epsilon2d * epsilon2d || polygonSelfIntersects(contour, epsilon2d)) {
    return {
      status: 'unsupported',
      code: 'self_intersecting_seam',
      message: '接缝投影发生自交或面积退化，不能生成可靠封口',
    };
  }
  const maxDeviationMm = Math.max(...world.map((point) => Math.abs(dot(subtract(point, center), planeNormal))));
  const warpRatio = maxDeviationMm / diagonal;
  if (warpRatio > maxWarpRatio) {
    return {
      status: 'unsupported',
      code: 'cap_too_warped',
      message: `接缝扭曲过大（${(warpRatio * 100).toFixed(1)}%），请缩小吸附范围或调整引导方向`,
      details: { maxDeviationMm, warpRatio, maxWarpRatio },
    };
  }
  const rawTriangles = THREE.ShapeUtils.triangulateShape(
    contour.map((point) => point.clone()),
    [],
  );
  if (rawTriangles.length !== loop.length - 2) {
    return {
      status: 'unsupported',
      code: 'cap_failed',
      message: '接缝约束三角化不完整，已拒绝生成可能开裂的封口',
      details: { expectedFaces: loop.length - 2, actualFaces: rawTriangles.length },
    };
  }
  const polygonSign = Math.sign(area2);
  const triangles = rawTriangles.map(([a, b, c]) => (
    Math.sign(orient2d(contour[a], contour[b], contour[c])) === polygonSign
      ? [a, b, c] as [number, number, number]
      : [a, c, b] as [number, number, number]
  ));
  return { triangles, maxDeviationMm, warpRatio };
}

function unsupported(
  code: Extract<SurfaceCutResult, { status: 'unsupported' }>['code'],
  message: string,
  details?: Record<string, number>,
): SurfaceCutResult {
  return { status: 'unsupported', code, message, details };
}

/**
 * 以任意世界引导平面为搜索中心，对封闭流形的三角面双图做 s-t 最小割。
 * 边界沿现有网格边走，并可在带宽内偏移到更短、折角更明显且网格不过密的位置。
 * 只接受单一无分叉闭环；两侧共享同一约束三角化封口并再次做拓扑闭合验证。
 */
export function createSurfaceAdaptiveCut(input: SurfaceCutInput): SurfaceCutResult {
  const vertexCount = Math.floor(input.positions.length / 3);
  const facesTotal = input.index ? Math.floor(input.index.length / 3) : Math.floor(vertexCount / 3);
  const faceBudget = Math.max(1, Math.floor(input.faceBudget ?? SURFACE_CUT_FACE_BUDGET));
  const boundaryBudget = Math.max(3, Math.floor(input.boundaryBudget ?? SURFACE_CUT_BOUNDARY_BUDGET));
  if (!vertexCount || !facesTotal) return unsupported('invalid_geometry', '模型没有可切割的三角网格');
  if (facesTotal > faceBudget) {
    return unsupported('budget', `模型共 ${facesTotal.toLocaleString()} 面，超过表面切割 ${faceBudget.toLocaleString()} 面预算`, {
      facesTotal,
      faceBudget,
    });
  }
  const searchHalfWidthMm = Math.max(0.1, Number(input.searchHalfWidthMm));
  if (!Number.isFinite(searchHalfWidthMm)) return unsupported('invalid_geometry', '表面吸附范围无效');
  const guide = resolveGuide(input);
  if (!guide) return unsupported('invalid_geometry', '曲面切割引导平面无效');
  const preference = input.preference ?? 'balanced';
  const maxCapWarpRatio = clamp(input.maxCapWarpRatio ?? 0.12, 0.01, 0.25);

  const localPoints: Vec3[] = [];
  const localMin: Vec3 = [Infinity, Infinity, Infinity];
  const localMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < vertexCount; index += 1) {
    const point = localVertex(input.positions, index);
    if (!point) return unsupported('invalid_geometry', `顶点 #${index} 含无效坐标`);
    localPoints.push(point);
    for (let axis = 0; axis < 3; axis += 1) {
      localMin[axis] = Math.min(localMin[axis], point[axis]);
      localMax[axis] = Math.max(localMax[axis], point[axis]);
    }
  }
  const localDiagonal = Math.max(distance(localMin, localMax), 1);
  const weldEpsilon = Math.max(1e-6, localDiagonal * 1e-7);
  const matrix = transformMatrix(input.transform);
  const weldedByKey = new Map<string, number>();
  const originalToWeld = new Uint32Array(vertexCount);
  const weldedLocal: Vec3[] = [];
  const weldedWorld: Vec3[] = [];
  for (let index = 0; index < localPoints.length; index += 1) {
    const point = localPoints[index];
    const key = point.map((value) => Math.round(value / weldEpsilon)).join(',');
    let welded = weldedByKey.get(key);
    if (welded === undefined) {
      welded = weldedLocal.length;
      weldedByKey.set(key, welded);
      weldedLocal.push(point);
      weldedWorld.push(applyMatrix(point, matrix));
    }
    originalToWeld[index] = welded;
  }

  const faces: Face[] = [];
  const edges = new Map<string, MeshEdge>();
  let degenerateFaces = 0;
  for (let faceIndex = 0; faceIndex < facesTotal; faceIndex += 1) {
    const original = [0, 1, 2].map((corner) => Number(
      input.index ? input.index[faceIndex * 3 + corner] : faceIndex * 3 + corner,
    )) as [number, number, number];
    if (original.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
      return unsupported('invalid_geometry', `三角面 #${faceIndex} 的顶点索引无效`);
    }
    const welded = original.map((index) => originalToWeld[index]) as [number, number, number];
    const world = welded.map((index) => weldedWorld[index]) as [Vec3, Vec3, Vec3];
    const normalRaw = cross(subtract(world[1], world[0]), subtract(world[2], world[0]));
    const twiceArea = length(normalRaw);
    if (new Set(welded).size < 3 || twiceArea <= 1e-10) {
      degenerateFaces += 1;
      continue;
    }
    const face = faces.length;
    faces.push({
      original,
      welded,
      normalWorld: normalize(normalRaw),
      centroidGuide: (
        signedGuideDistance(world[0], guide)
        + signedGuideDistance(world[1], guide)
        + signedGuideDistance(world[2], guide)
      ) / 3,
      areaWorld: twiceArea / 2,
    });
    for (const [fromCorner, toCorner] of [[0, 1], [1, 2], [2, 0]] as const) {
      const from = welded[fromCorner];
      const to = welded[toCorner];
      const key = edgeKey(from, to);
      let edge = edges.get(key);
      if (!edge) {
        edge = { a: Math.min(from, to), b: Math.max(from, to), uses: [] };
        edges.set(key, edge);
      }
      edge.uses.push({ face, from, to });
    }
  }
  if (degenerateFaces > 0 || faces.length !== facesTotal) {
    return unsupported('invalid_geometry', `源模型含 ${degenerateFaces.toLocaleString()} 个退化面，请先修复`, {
      degenerateFaces,
    });
  }
  const invalidEdges = [...edges.values()].filter((edge) => edge.uses.length !== 2);
  if (invalidEdges.length) {
    const boundaryEdges = invalidEdges.filter((edge) => edge.uses.length === 1).length;
    const nonManifoldEdges = invalidEdges.filter((edge) => edge.uses.length > 2).length;
    return unsupported('non_manifold_source', '表面自适应切割只接受水密单一流形；请先修复边界边或非流形边', {
      boundaryEdges,
      nonManifoldEdges,
    });
  }

  const faceNeighbors = Array.from({ length: faces.length }, () => [] as number[]);
  for (const edge of edges.values()) {
    const [a, b] = edge.uses;
    faceNeighbors[a.face].push(b.face);
    faceNeighbors[b.face].push(a.face);
  }
  const connected = new Uint8Array(faces.length);
  let connectedComponents = 0;
  for (let start = 0; start < faces.length; start += 1) {
    if (connected[start]) continue;
    connectedComponents += 1;
    const queue = [start];
    connected[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      for (const neighbor of faceNeighbors[queue[cursor]]) {
        if (connected[neighbor]) continue;
        connected[neighbor] = 1;
        queue.push(neighbor);
      }
    }
  }
  if (connectedComponents !== 1) {
    return unsupported('non_manifold_source', '表面自适应切割只接受单一连通水密流形；请先拆分独立壳', {
      connectedComponents,
    });
  }

  const faceAreas = faces.map((face) => face.areaWorld);
  const medianArea = median(faceAreas);
  const pairs: PairCost[] = [];
  let capacitySum = 0;
  for (const edge of edges.values()) {
    const [useA, useB] = edge.uses;
    const faceA = faces[useA.face];
    const faceB = faces[useB.face];
    const worldA = weldedWorld[edge.a];
    const worldB = weldedWorld[edge.b];
    const edgeLength = Math.max(distance(worldA, worldB), 1e-6);
    const normalDot = clamp(dot(faceA.normalWorld, faceB.normalWorld), -1, 1);
    const creaseDeg = Math.acos(normalDot) * 180 / Math.PI;
    const smoothness = (normalDot + 1) / 2;
    const midpointGuide = (
      signedGuideDistance(worldA, guide) + signedGuideDistance(worldB, guide)
    ) / 2;
    const guideRatio = Math.abs(midpointGuide) / searchHalfWidthMm;
    const guidePenalty = 1 + Math.pow(guideRatio, 2) * 4;
    const localArea = Math.max(Math.min(faceA.areaWorld, faceB.areaWorld), 1e-9);
    const densityRatio = clamp(medianArea / localArea, 1, 4);
    const densityPenalty = 1 + (densityRatio - 1) * 0.35;
    const surfacePenalty = preferencePenalty(preference, smoothness);
    const capacity = edgeLength * guidePenalty * densityPenalty * surfacePenalty;
    pairs.push({ edge, faceA: useA.face, faceB: useB.face, capacity, creaseDeg });
    capacitySum += capacity;
  }

  const source = faces.length;
  const sink = faces.length + 1;
  const flow = new Dinic(faces.length + 2);
  for (const pair of pairs) flow.addPair(pair.faceA, pair.faceB, pair.capacity);
  const hardCapacity = Math.max(capacitySum * 4 + 1, 1_000_000);
  let sourceSeeds = 0;
  let sinkSeeds = 0;
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
    const signed = faces[faceIndex].centroidGuide;
    if (signed <= -searchHalfWidthMm) {
      flow.addDirected(source, faceIndex, hardCapacity);
      sourceSeeds += 1;
    } else if (signed >= searchHalfWidthMm) {
      flow.addDirected(faceIndex, sink, hardCapacity);
      sinkSeeds += 1;
    }
  }
  if (!sourceSeeds || !sinkSeeds) {
    return unsupported('missing_seeds', '吸附范围覆盖了模型一侧，无法建立稳定的 A/B 种子；请减小范围或移动引导位置', {
      sourceSeeds,
      sinkSeeds,
    });
  }
  flow.maxFlow(source, sink);
  const reachable = flow.reachableFrom(source);
  const labels = new Uint8Array(faces.length);
  let facesA = 0;
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
    labels[faceIndex] = reachable[faceIndex] ? 0 : 1;
    if (labels[faceIndex] === 0) facesA += 1;
  }
  if (!facesA || facesA === faces.length) {
    return unsupported('missing_seeds', '表面分区没有形成两个有效部分，请调整引导位置或吸附范围');
  }

  const boundaryPairs = pairs.filter((pair) => labels[pair.faceA] !== labels[pair.faceB]);
  if (boundaryPairs.length > boundaryBudget) {
    return unsupported('boundary_budget', `接缝超过 ${boundaryBudget.toLocaleString()} 条边预算`, {
      boundaryEdges: boundaryPairs.length,
      boundaryBudget,
    });
  }
  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number>();
  const directedBoundary: [number, number][] = [];
  for (const pair of boundaryPairs) {
    const aUse = pair.edge.uses.find((use) => labels[use.face] === 0)!;
    directedBoundary.push([aUse.from, aUse.to]);
    const next = outgoing.get(aUse.from) ?? [];
    next.push(aUse.to);
    outgoing.set(aUse.from, next);
    incoming.set(aUse.to, (incoming.get(aUse.to) ?? 0) + 1);
  }
  const boundaryVertices = new Set(directedBoundary.flat());
  const branching = [...boundaryVertices].filter((vertex) => (
    (outgoing.get(vertex)?.length ?? 0) !== 1 || (incoming.get(vertex) ?? 0) !== 1
  ));
  if (branching.length) {
    return unsupported('branching_seam', '候选接缝出现分叉或绕序不一致，不能安全封口', {
      branchPoints: branching.length,
      boundaryEdges: directedBoundary.length,
    });
  }
  const first = directedBoundary[0]?.[0];
  if (first === undefined) return unsupported('branching_seam', '没有形成可封口的表面接缝');
  const loop: number[] = [first];
  let current = first;
  for (let step = 0; step <= directedBoundary.length; step += 1) {
    const next = outgoing.get(current)![0];
    if (next === first) break;
    loop.push(next);
    current = next;
  }
  if (loop.length !== directedBoundary.length) {
    return unsupported('multiple_seams', '当前分区形成多个独立接缝环；首版只支持一个闭合环', {
      visitedEdges: loop.length,
      boundaryEdges: directedBoundary.length,
    });
  }

  const cap = triangulateCap(loop, weldedWorld, maxCapWarpRatio);
  if ('status' in cap) return cap;
  const partA: number[] = [];
  const partB: number[] = [];
  const appendFace = (target: number[], face: Face) => {
    for (const vertex of face.original) target.push(...localPoints[vertex]);
  };
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
    appendFace(labels[faceIndex] === 0 ? partA : partB, faces[faceIndex]);
  }
  for (const [a, b, c] of cap.triangles) {
    const pointA = weldedLocal[loop[a]];
    const pointB = weldedLocal[loop[b]];
    const pointC = weldedLocal[loop[c]];
    partA.push(...pointA, ...pointC, ...pointB);
    partB.push(...pointA, ...pointB, ...pointC);
  }
  const partAPositions = new Float32Array(partA);
  const partBPositions = new Float32Array(partB);
  const boundaryA = boundaryEdgeCount(partAPositions, weldEpsilon);
  const boundaryB = boundaryEdgeCount(partBPositions, weldEpsilon);
  if (boundaryA || boundaryB) {
    return unsupported('cap_failed', '临时封口未通过拓扑闭合验证，已拒绝生成不可靠零件', {
      partABoundaryEdges: boundaryA,
      partBBoundaryEdges: boundaryB,
    });
  }

  const seamPositions = new Float32Array(directedBoundary.length * 6);
  let seamLengthMm = 0;
  let seamAxisMin = Infinity;
  let seamAxisMax = -Infinity;
  let seamAxisSum = 0;
  let creaseSum = 0;
  directedBoundary.forEach(([from, to], index) => {
    seamPositions.set(weldedLocal[from], index * 6);
    seamPositions.set(weldedLocal[to], index * 6 + 3);
    const fromWorld = weldedWorld[from];
    const toWorld = weldedWorld[to];
    seamLengthMm += distance(fromWorld, toWorld);
    const fromGuide = signedGuideDistance(fromWorld, guide);
    const toGuide = signedGuideDistance(toWorld, guide);
    seamAxisMin = Math.min(seamAxisMin, fromGuide, toGuide);
    seamAxisMax = Math.max(seamAxisMax, fromGuide, toGuide);
    seamAxisSum += (fromGuide + toGuide) / 2;
    creaseSum += boundaryPairs[index]?.creaseDeg ?? 0;
  });
  const seamAxisMean = seamAxisSum / directedBoundary.length;
  const warnings: string[] = [
    '接缝沿现有网格边移动；低面数模型的吸附精度受拓扑分辨率限制',
    '封口已通过投影自交、扭曲阈值与拓扑闭合验证；尚未验证受力、装配公差或全模型自交',
  ];
  return {
    status: 'ready',
    partA: {
      positions: partAPositions,
      sourceFaceCount: facesA,
      capFaceCount: cap.triangles.length,
      boundaryEdges: boundaryA,
      dimensionsMm: dimensionsOfWorldTriangles(partAPositions, matrix),
    },
    partB: {
      positions: partBPositions,
      sourceFaceCount: faces.length - facesA,
      capFaceCount: cap.triangles.length,
      boundaryEdges: boundaryB,
      dimensionsMm: dimensionsOfWorldTriangles(partBPositions, matrix),
    },
    seamPositions,
    metrics: {
      sourceFaces: faces.length,
      partAFaces: facesA + cap.triangles.length,
      partBFaces: faces.length - facesA + cap.triangles.length,
      boundaryVertices: loop.length,
      seamLengthMm,
      guideOffsetMm: seamAxisMean,
      adaptiveSpanMm: seamAxisMax - seamAxisMin,
      meanCreaseDeg: creaseSum / directedBoundary.length,
      searchHalfWidthMm,
      maxCapDeviationMm: cap.maxDeviationMm,
      capWarpRatio: cap.warpRatio,
      preference,
    },
    warnings,
  };
}
