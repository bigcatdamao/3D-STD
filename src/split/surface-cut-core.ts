import * as THREE from 'three';
import type { Transform, Vec3 } from '../kernel/types';
import { projectSeamLoop } from './seam-projection-core';

export const SURFACE_CUT_FACE_BUDGET = 80_000;
export const SURFACE_CUT_BOUNDARY_BUDGET = 12_000;
export const SURFACE_CUT_CAP_CONTOUR_BUDGET = 12_000;
export const FACE_SET_CUT_FACE_BUDGET = 2_000_000;
export const FACE_SET_CUT_SELECTED_FACE_BUDGET = 500_000;
export type SurfaceCutPreference = 'balanced' | 'shortest' | 'crease';

export interface SurfaceCutInput {
  positions: ArrayLike<number>;
  index?: ArrayLike<number> | null;
  /** M1.11c 面组切割：1 为用户涂出的拆下件 A，0 为保留件 B。 */
  faceLabels?: ArrayLike<number>;
  transform: Transform;
  /** M1.7.8 兼容入口；新交互使用任意世界引导平面。 */
  axisIndex?: 0 | 1 | 2;
  guidePositionMm?: number;
  guideOriginWorld?: Vec3;
  guideNormalWorld?: Vec3;
  /** 世界空间贴面闭环；存在时，接缝代价以闭环距离为主，引导平面只负责建立 A/B 种子。 */
  guidePointsWorld?: Vec3[];
  searchHalfWidthMm: number;
  preference?: SurfaceCutPreference;
  maxCapWarpRatio?: number;
  faceBudget?: number;
  selectedFaceBudget?: number;
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

function pointSegmentDistance(point: Vec3, start: Vec3, end: Vec3): number {
  const segment = subtract(end, start);
  const segmentLengthSq = dot(segment, segment);
  if (segmentLengthSq <= 1e-12) return distance(point, start);
  const offset = subtract(point, start);
  const factor = clamp(dot(offset, segment) / segmentLengthSq, 0, 1);
  return distance(point, [
    start[0] + segment[0] * factor,
    start[1] + segment[1] * factor,
    start[2] + segment[2] * factor,
  ]);
}

function closedGuideDistance(point: Vec3, guidePoints: Vec3[]): number {
  let nearest = Infinity;
  for (let index = 0; index < guidePoints.length; index += 1) {
    nearest = Math.min(nearest, pointSegmentDistance(
      point,
      guidePoints[index],
      guidePoints[(index + 1) % guidePoints.length],
    ));
  }
  return nearest;
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

function orient2d(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
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
  const projection = projectSeamLoop(world);
  if (projection.status === 'degenerate') {
    return {
      status: 'unsupported',
      code: 'cap_failed',
      message: '接缝无法建立稳定的封口投影平面',
    };
  }
  if (projection.status === 'self_intersection') {
    return {
      status: 'unsupported',
      code: 'self_intersecting_seam',
      message: '接缝投影发生自交或面积退化，不能生成可靠封口',
    };
  }
  const contour = projection.contour.map(([x, y]) => new THREE.Vector2(x, y));
  const area2 = projection.signedArea2;
  const maxDeviationMm = projection.maxDeviation;
  const warpRatio = projection.warpRatio;
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
 * M1.11d high-poly face-set path.
 *
 * The user's purple mask already decides A/B, so this path does not build the
 * global face dual graph or run min-cut. It keeps only edges touched by the
 * painted joint patch, scans the source once for their opposite face, validates
 * one local closed seam, and then streams triangles into the two derived parts.
 */
function createFaceSetSurfaceCut(
  input: SurfaceCutInput,
  facesTotal: number,
  vertexCount: number,
  faceBudget: number,
  boundaryBudget: number,
  maxCapWarpRatio: number,
): SurfaceCutResult {
  const faceLabels = input.faceLabels!;
  if (faceLabels.length !== facesTotal) {
    return unsupported('invalid_geometry', '面组数据与当前网格面数不一致，请返回重新涂画', {
      faceLabels: faceLabels.length,
      facesTotal,
    });
  }
  if (facesTotal > faceBudget) {
    return unsupported('budget', `模型共 ${facesTotal.toLocaleString()} 面，超过局部面组切割 ${faceBudget.toLocaleString()} 面预算`, {
      facesTotal,
      faceBudget,
    });
  }

  let selectedFaces = 0;
  for (let faceIndex = 0; faceIndex < facesTotal; faceIndex += 1) {
    const value = Number(faceLabels[faceIndex]);
    if (value !== 0 && value !== 1) {
      return unsupported('invalid_geometry', `面组 #${faceIndex} 的标签无效，请返回重新涂画`);
    }
    selectedFaces += value;
  }
  if (!selectedFaces || selectedFaces === facesTotal) {
    return unsupported('missing_seeds', '紫色面组必须只覆盖模型的一部分，请返回修改面组');
  }
  const selectedFaceBudget = Math.max(
    1,
    Math.floor(input.selectedFaceBudget ?? FACE_SET_CUT_SELECTED_FACE_BUDGET),
  );
  if (selectedFaces > selectedFaceBudget) {
    return unsupported(
      'budget',
      `紫色局部面组共 ${selectedFaces.toLocaleString()} 面，超过关节精细拆件 ${selectedFaceBudget.toLocaleString()} 面预算`,
      { selectedFaces, selectedFaceBudget },
    );
  }

  const localMin: Vec3 = [Infinity, Infinity, Infinity];
  const localMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const point = localVertex(input.positions, vertex);
    if (!point) return unsupported('invalid_geometry', `顶点 #${vertex} 含无效坐标`);
    for (let axis = 0; axis < 3; axis += 1) {
      localMin[axis] = Math.min(localMin[axis], point[axis]);
      localMax[axis] = Math.max(localMax[axis], point[axis]);
    }
  }
  const localDiagonal = Math.max(distance(localMin, localMax), 1);
  const weldEpsilon = Math.max(1e-6, localDiagonal * 1e-7);
  const inverse = 1 / weldEpsilon;
  const matrix = transformMatrix(input.transform);
  const localVertexById: Vec3[] = [];
  const worldVertexById: Vec3[] = [];
  const vertexIdByKey = new Map<string, number>();
  const localEdges = new Map<string, MeshEdge>();

  const originalIndex = (face: number, corner: number): number => Number(
    input.index ? input.index[face * 3 + corner] : face * 3 + corner,
  );
  const validOriginalIndex = (value: number) => (
    Number.isInteger(value) && value >= 0 && value < vertexCount
  );
  const positionKey = (original: number) => {
    const offset = original * 3;
    return `${Math.round(Number(input.positions[offset]) * inverse)},${Math.round(Number(input.positions[offset + 1]) * inverse)},${Math.round(Number(input.positions[offset + 2]) * inverse)}`;
  };
  const localId = (key: string, original: number): number => {
    const current = vertexIdByKey.get(key);
    if (current !== undefined) return current;
    const point = localVertex(input.positions, original)!;
    const next = localVertexById.length;
    vertexIdByKey.set(key, next);
    localVertexById.push(point);
    worldVertexById.push(applyMatrix(point, matrix));
    return next;
  };
  const keyOfKeys = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (let face = 0; face < facesTotal; face += 1) {
    if (Number(faceLabels[face]) !== 1) continue;
    const originals: [number, number, number] = [
      originalIndex(face, 0),
      originalIndex(face, 1),
      originalIndex(face, 2),
    ];
    if (originals.some((value) => !validOriginalIndex(value))) {
      return unsupported('invalid_geometry', `三角面 #${face} 的顶点索引无效`);
    }
    const keys = originals.map(positionKey) as [string, string, string];
    if (new Set(keys).size < 3) {
      return unsupported('invalid_geometry', `紫色面组含退化三角面 #${face}，请先修复网格`);
    }
    const ids = keys.map((key, corner) => localId(key, originals[corner])) as [number, number, number];
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
      const next = (edgeIndex + 1) % 3;
      const key = keyOfKeys(keys[edgeIndex], keys[next]);
      const use: EdgeUse = { face, from: ids[edgeIndex], to: ids[next] };
      const edge = localEdges.get(key);
      if (edge) edge.uses.push(use);
      else {
        localEdges.set(key, {
          a: Math.min(ids[edgeIndex], ids[next]),
          b: Math.max(ids[edgeIndex], ids[next]),
          uses: [use],
        });
      }
    }
  }

  // Only compare unpainted edges with keys already created by the joint patch.
  for (let face = 0; face < facesTotal; face += 1) {
    if (Number(faceLabels[face]) === 1) continue;
    const originals: [number, number, number] = [
      originalIndex(face, 0),
      originalIndex(face, 1),
      originalIndex(face, 2),
    ];
    if (originals.some((value) => !validOriginalIndex(value))) {
      return unsupported('invalid_geometry', `三角面 #${face} 的顶点索引无效`);
    }
    const keys = originals.map(positionKey) as [string, string, string];
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
      const next = (edgeIndex + 1) % 3;
      const edge = localEdges.get(keyOfKeys(keys[edgeIndex], keys[next]));
      if (!edge) continue;
      edge.uses.push({
        face,
        from: vertexIdByKey.get(keys[edgeIndex])!,
        to: vertexIdByKey.get(keys[next])!,
      });
    }
  }

  const invalidEdges = [...localEdges.values()].filter((edge) => edge.uses.length !== 2);
  if (invalidEdges.length) {
    const boundaryEdges = invalidEdges.filter((edge) => edge.uses.length === 1).length;
    const nonManifoldEdges = invalidEdges.filter((edge) => edge.uses.length > 2).length;
    return unsupported(
      'non_manifold_source',
      '紫色关节区域接触到开放边或非流形边，请先修复接缝附近网格',
      { boundaryEdges, nonManifoldEdges },
    );
  }

  const boundaryEdges = [...localEdges.values()].filter((edge) => {
    const [a, b] = edge.uses;
    return Number(faceLabels[a.face]) !== Number(faceLabels[b.face]);
  });
  if (boundaryEdges.length > boundaryBudget) {
    return unsupported('boundary_budget', `局部接缝超过 ${boundaryBudget.toLocaleString()} 条边预算`, {
      boundaryEdges: boundaryEdges.length,
      boundaryBudget,
    });
  }
  if (!boundaryEdges.length) {
    const partA = new Float32Array(selectedFaces * 9);
    const partB = new Float32Array((facesTotal - selectedFaces) * 9);
    let offsetA = 0;
    let offsetB = 0;
    for (let face = 0; face < facesTotal; face += 1) {
      const selected = Number(faceLabels[face]) === 1;
      const target = selected ? partA : partB;
      let offset = selected ? offsetA : offsetB;
      for (let corner = 0; corner < 3; corner += 1) {
        const original = originalIndex(face, corner);
        const pointOffset = original * 3;
        target[offset++] = Number(input.positions[pointOffset]);
        target[offset++] = Number(input.positions[pointOffset + 1]);
        target[offset++] = Number(input.positions[pointOffset + 2]);
      }
      if (selected) offsetA = offset;
      else offsetB = offset;
    }
    return {
      status: 'ready',
      partA: {
        positions: partA,
        sourceFaceCount: selectedFaces,
        capFaceCount: 0,
        boundaryEdges: 0,
        dimensionsMm: dimensionsOfWorldTriangles(partA, matrix),
      },
      partB: {
        positions: partB,
        sourceFaceCount: facesTotal - selectedFaces,
        capFaceCount: 0,
        boundaryEdges: 0,
        dimensionsMm: dimensionsOfWorldTriangles(partB, matrix),
      },
      seamPositions: new Float32Array(0),
      metrics: {
        sourceFaces: facesTotal,
        partAFaces: selectedFaces,
        partBFaces: facesTotal - selectedFaces,
        boundaryVertices: 0,
        seamLengthMm: 0,
        guideOffsetMm: 0,
        adaptiveSpanMm: 0,
        meanCreaseDeg: 0,
        searchHalfWidthMm: 0,
        maxCapDeviationMm: 0,
        capWarpRatio: 0,
        preference: input.preference ?? 'balanced',
      },
      warnings: [
        '紫色区域已经由独立闭合壳体组成，本次只执行壳体分组，不新增切口或封口',
        '源模型其他区域的水密、非流形和自交仍以打印检查结果为准',
      ],
    };
  }

  const outgoing = new Map<number, number[]>();
  const incoming = new Map<number, number>();
  const directedBoundary: [number, number][] = [];
  for (const edge of boundaryEdges) {
    const selectedUse = edge.uses.find((use) => Number(faceLabels[use.face]) === 1)!;
    directedBoundary.push([selectedUse.from, selectedUse.to]);
    const next = outgoing.get(selectedUse.from) ?? [];
    next.push(selectedUse.to);
    outgoing.set(selectedUse.from, next);
    incoming.set(selectedUse.to, (incoming.get(selectedUse.to) ?? 0) + 1);
  }
  const boundaryVertices = new Set(directedBoundary.flat());
  const branching = [...boundaryVertices].filter((vertex) => (
    (outgoing.get(vertex)?.length ?? 0) !== 1 || (incoming.get(vertex) ?? 0) !== 1
  ));
  if (branching.length) {
    return unsupported('branching_seam', '局部接缝出现分叉或断点，请补涂或擦除后重试', {
      branchPoints: branching.length,
      boundaryEdges: directedBoundary.length,
    });
  }

  const first = directedBoundary[0][0];
  const loop: number[] = [first];
  let current = first;
  for (let step = 0; step <= directedBoundary.length; step += 1) {
    const next = outgoing.get(current)?.[0];
    if (next === undefined) {
      return unsupported('branching_seam', '局部接缝没有形成连续闭环');
    }
    if (next === first) break;
    loop.push(next);
    current = next;
  }
  if (loop.length !== directedBoundary.length) {
    return unsupported('multiple_seams', '当前紫色面组形成多个独立接缝环；每次只处理一个关节', {
      visitedEdges: loop.length,
      boundaryEdges: directedBoundary.length,
    });
  }

  const cap = triangulateCap(loop, worldVertexById, maxCapWarpRatio);
  if ('status' in cap) return cap;
  const partA = new Float32Array((selectedFaces + cap.triangles.length) * 9);
  const partB = new Float32Array((facesTotal - selectedFaces + cap.triangles.length) * 9);
  let offsetA = 0;
  let offsetB = 0;
  for (let face = 0; face < facesTotal; face += 1) {
    const target = Number(faceLabels[face]) === 1 ? partA : partB;
    let offset = Number(faceLabels[face]) === 1 ? offsetA : offsetB;
    for (let corner = 0; corner < 3; corner += 1) {
      const original = originalIndex(face, corner);
      const pointOffset = original * 3;
      target[offset++] = Number(input.positions[pointOffset]);
      target[offset++] = Number(input.positions[pointOffset + 1]);
      target[offset++] = Number(input.positions[pointOffset + 2]);
    }
    if (target === partA) offsetA = offset;
    else offsetB = offset;
  }
  for (const [a, b, c] of cap.triangles) {
    const pointA = localVertexById[loop[a]];
    const pointB = localVertexById[loop[b]];
    const pointC = localVertexById[loop[c]];
    partA.set([...pointA, ...pointC, ...pointB], offsetA);
    offsetA += 9;
    partB.set([...pointA, ...pointB, ...pointC], offsetB);
    offsetB += 9;
  }

  const seamPositions = new Float32Array(directedBoundary.length * 6);
  let seamLengthMm = 0;
  directedBoundary.forEach(([from, to], index) => {
    seamPositions.set(localVertexById[from], index * 6);
    seamPositions.set(localVertexById[to], index * 6 + 3);
    seamLengthMm += distance(worldVertexById[from], worldVertexById[to]);
  });
  const faceWorldNormal = (face: number): Vec3 => {
    const points = [0, 1, 2].map((corner) => (
      applyMatrix(localVertex(input.positions, originalIndex(face, corner))!, matrix)
    )) as [Vec3, Vec3, Vec3];
    return normalize(cross(subtract(points[1], points[0]), subtract(points[2], points[0])));
  };
  let creaseSum = 0;
  for (const edge of boundaryEdges) {
    const normalA = faceWorldNormal(edge.uses[0].face);
    const normalB = faceWorldNormal(edge.uses[1].face);
    creaseSum += Math.acos(clamp(dot(normalA, normalB), -1, 1)) * 180 / Math.PI;
  }

  return {
    status: 'ready',
    partA: {
      positions: partA,
      sourceFaceCount: selectedFaces,
      capFaceCount: cap.triangles.length,
      boundaryEdges: 0,
      dimensionsMm: dimensionsOfWorldTriangles(partA, matrix),
    },
    partB: {
      positions: partB,
      sourceFaceCount: facesTotal - selectedFaces,
      capFaceCount: cap.triangles.length,
      boundaryEdges: 0,
      dimensionsMm: dimensionsOfWorldTriangles(partB, matrix),
    },
    seamPositions,
    metrics: {
      sourceFaces: facesTotal,
      partAFaces: selectedFaces + cap.triangles.length,
      partBFaces: facesTotal - selectedFaces + cap.triangles.length,
      boundaryVertices: loop.length,
      seamLengthMm,
      guideOffsetMm: 0,
      adaptiveSpanMm: 0,
      meanCreaseDeg: creaseSum / boundaryEdges.length,
      searchHalfWidthMm: 0,
      maxCapDeviationMm: cap.maxDeviationMm,
      capWarpRatio: cap.warpRatio,
      preference: input.preference ?? 'balanced',
    },
    warnings: [
      '紫色面组生成拆下件 A，未涂区域生成保留件 B；高面数模式只构建关节局部接缝',
      '接缝与两侧封口已验证；源模型其他区域的水密、非流形和自交仍以打印检查结果为准',
    ],
  };
}

/**
 * 以任意世界引导平面为搜索中心，对封闭流形的三角面双图做 s-t 最小割。
 * 边界沿现有网格边走，并可在带宽内偏移到更短、折角更明显且网格不过密的位置。
 * 只接受单一无分叉闭环；两侧共享同一约束三角化封口并再次做拓扑闭合验证。
 */
export function createSurfaceAdaptiveCut(input: SurfaceCutInput): SurfaceCutResult {
  const vertexCount = Math.floor(input.positions.length / 3);
  const facesTotal = input.index ? Math.floor(input.index.length / 3) : Math.floor(vertexCount / 3);
  const usesFaceLabels = input.faceLabels !== undefined;
  const faceBudget = Math.max(1, Math.floor(
    input.faceBudget ?? (usesFaceLabels ? FACE_SET_CUT_FACE_BUDGET : SURFACE_CUT_FACE_BUDGET),
  ));
  const boundaryBudget = Math.max(3, Math.floor(input.boundaryBudget ?? SURFACE_CUT_BOUNDARY_BUDGET));
  if (!vertexCount || !facesTotal) return unsupported('invalid_geometry', '模型没有可切割的三角网格');
  const maxCapWarpRatio = clamp(input.maxCapWarpRatio ?? 0.12, 0.01, 0.25);
  if (usesFaceLabels) {
    return createFaceSetSurfaceCut(
      input,
      facesTotal,
      vertexCount,
      faceBudget,
      boundaryBudget,
      maxCapWarpRatio,
    );
  }
  if (facesTotal > faceBudget) {
    return unsupported('budget', `模型共 ${facesTotal.toLocaleString()} 面，超过表面切割 ${faceBudget.toLocaleString()} 面预算`, {
      facesTotal,
      faceBudget,
    });
  }
  const searchHalfWidthMm = Math.max(0.1, Number(input.searchHalfWidthMm));
  if (!Number.isFinite(searchHalfWidthMm)) return unsupported('invalid_geometry', '表面吸附范围无效');
  const guide = resolveGuide(input);
  if (!guide && !usesFaceLabels) return unsupported('invalid_geometry', '曲面切割引导平面无效');
  const resolvedGuide = guide ?? { origin: [0, 0, 0] as Vec3, normal: [1, 0, 0] as Vec3 };
  const guidePoints = input.guidePointsWorld?.filter(finiteVec3).map((point) => [...point] as Vec3) ?? [];
  if (input.guidePointsWorld && guidePoints.length !== input.guidePointsWorld.length) {
    return unsupported('invalid_geometry', '贴面曲线含无效控制点');
  }
  if (guidePoints.length > 0 && guidePoints.length < 3) {
    return unsupported('invalid_geometry', '贴面曲线至少需要 3 个控制点');
  }
  const preference = input.preference ?? 'balanced';

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
      centroidGuide: usesFaceLabels ? 0 : (
        signedGuideDistance(world[0], resolvedGuide)
        + signedGuideDistance(world[1], resolvedGuide)
        + signedGuideDistance(world[2], resolvedGuide)
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
    let capacity = edgeLength;
    if (!usesFaceLabels) {
      const midpoint: Vec3 = [
        (worldA[0] + worldB[0]) / 2,
        (worldA[1] + worldB[1]) / 2,
        (worldA[2] + worldB[2]) / 2,
      ];
      const guideDistance = guidePoints.length >= 3
        ? closedGuideDistance(midpoint, guidePoints)
        : Math.abs((
          signedGuideDistance(worldA, resolvedGuide) + signedGuideDistance(worldB, resolvedGuide)
        ) / 2);
      const guideRatio = guideDistance / searchHalfWidthMm;
      const guidePenalty = 1 + Math.pow(guideRatio, 2) * 4;
      const localArea = Math.max(Math.min(faceA.areaWorld, faceB.areaWorld), 1e-9);
      const densityRatio = clamp(medianArea / localArea, 1, 4);
      const densityPenalty = 1 + (densityRatio - 1) * 0.35;
      const surfacePenalty = preferencePenalty(preference, smoothness);
      capacity = edgeLength * guidePenalty * densityPenalty * surfacePenalty;
    }
    pairs.push({ edge, faceA: useA.face, faceB: useB.face, capacity, creaseDeg });
    capacitySum += capacity;
  }

  const labels = new Uint8Array(faces.length);
  let facesA = 0;
  if (usesFaceLabels) {
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
      const value = Number(input.faceLabels![faceIndex]);
      if (value !== 0 && value !== 1) {
        return unsupported('invalid_geometry', `面组 #${faceIndex} 的标签无效，请返回重新涂画`);
      }
      labels[faceIndex] = value === 1 ? 0 : 1;
      if (value === 1) facesA += 1;
    }
  } else {
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
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
      labels[faceIndex] = reachable[faceIndex] ? 0 : 1;
      if (labels[faceIndex] === 0) facesA += 1;
    }
  }
  if (!facesA || facesA === faces.length) {
    return unsupported(
      'missing_seeds',
      usesFaceLabels
        ? '紫色面组必须只覆盖模型的一部分，请返回修改面组'
        : '表面分区没有形成两个有效部分，请调整引导位置或吸附范围',
    );
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
  let seamGuideMin = Infinity;
  let seamGuideMax = -Infinity;
  let seamGuideSum = 0;
  let creaseSum = 0;
  directedBoundary.forEach(([from, to], index) => {
    seamPositions.set(weldedLocal[from], index * 6);
    seamPositions.set(weldedLocal[to], index * 6 + 3);
    const fromWorld = weldedWorld[from];
    const toWorld = weldedWorld[to];
    seamLengthMm += distance(fromWorld, toWorld);
    const fromGuide = usesFaceLabels
      ? 0
      : guidePoints.length >= 3
        ? closedGuideDistance(fromWorld, guidePoints)
        : signedGuideDistance(fromWorld, resolvedGuide);
    const toGuide = usesFaceLabels
      ? 0
      : guidePoints.length >= 3
        ? closedGuideDistance(toWorld, guidePoints)
        : signedGuideDistance(toWorld, resolvedGuide);
    seamGuideMin = Math.min(seamGuideMin, fromGuide, toGuide);
    seamGuideMax = Math.max(seamGuideMax, fromGuide, toGuide);
    seamGuideSum += (fromGuide + toGuide) / 2;
    creaseSum += boundaryPairs[index]?.creaseDeg ?? 0;
  });
  const seamGuideMean = seamGuideSum / directedBoundary.length;
  const warnings: string[] = [
    usesFaceLabels
      ? '紫色面组生成拆下件 A，未涂区域生成保留件 B；接缝严格沿已验证的绿色闭环'
      : '接缝沿现有网格边移动；低面数模型的吸附精度受拓扑分辨率限制',
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
      guideOffsetMm: seamGuideMean,
      adaptiveSpanMm: seamGuideMax - seamGuideMin,
      meanCreaseDeg: creaseSum / directedBoundary.length,
      searchHalfWidthMm,
      maxCapDeviationMm: cap.maxDeviationMm,
      capWarpRatio: cap.warpRatio,
      preference,
    },
    warnings,
  };
}
