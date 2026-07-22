import { bboxOfPositions } from '../importer/parse-core';

export type MeshHealthVec3 = [number, number, number];
type Vec3 = MeshHealthVec3;
type Tri = [number, number, number];

export const MAX_SELF_INTERSECTION_TRIANGLES = 60_000;
export const MAX_SELF_INTERSECTION_PAIR_TESTS = 500_000;
export const MAX_SELF_INTERSECTION_HITS = 200;
/** 视口逐条浏览只保留前 24 组确定命中，避免把大型模型的诊断证据无限传回主线程。 */
export const MAX_SELF_INTERSECTION_EVIDENCE = 24;
export const MAX_COMPONENT_ANALYSIS_TRIANGLES = 250_000;
/** 逐壳预览只展示面积最大的前 24 个连通壳，避免异常碎片模型撑爆检查面板。 */
export const MAX_COMPONENT_EVIDENCE = 24;
/** Worker 返回给主线程的逐壳预览面预算；完整壳统计不受该预算影响。 */
export const MAX_COMPONENT_PREVIEW_FACES = 120_000;

export interface SelfIntersectionEvidence {
  /** 1-based 原始三角面序号，便于在 UI 中与外部网格工具核对。 */
  faceA: number;
  faceB: number;
  /** 资产局部坐标；视口按实例 TRS 变换后只读高亮。 */
  triangleA: [Vec3, Vec3, Vec3];
  triangleB: [Vec3, Vec3, Vec3];
}

export type ConnectedComponentKind = 'primary' | 'separate' | 'internal' | 'fragment';

/** M1.7.3 只读拆件预览证据。sourceFaceIndices 为原始几何的 0-based 三角面序号。 */
export interface ConnectedComponentEvidence {
  componentIndex: number;
  faceCount: number;
  closed: boolean;
  kind: ConnectedComponentKind;
  bounds: { min: Vec3; max: Vec3 };
  sourceFaceIndices: number[];
  previewComplete: boolean;
}

export interface MeshHealthAnalysis {
  connectedComponents: number;
  closedComponents: number;
  componentAnalysisComplete: boolean;
  componentEvidence: ConnectedComponentEvidence[];
  componentEvidenceComplete: boolean;
  isolatedFragments: number;
  isolatedFragmentFaces: number;
  internalShells: number;
  selfIntersectionPairs: number;
  selfIntersectionComplete: boolean;
  selfIntersectionTrianglesScanned: number;
  selfIntersectionPairTests: number;
  selfIntersectionEvidence: SelfIntersectionEvidence[];
}

export interface MeshHealthOptions {
  maxSelfIntersectionTriangles?: number;
  maxSelfIntersectionPairTests?: number;
  maxSelfIntersectionHits?: number;
  maxSelfIntersectionEvidence?: number;
  maxComponentAnalysisTriangles?: number;
  maxComponentEvidence?: number;
  maxComponentPreviewFaces?: number;
}

interface PreparedMesh {
  vertices: Vec3[];
  triangles: Tri[];
  triangleSourceFaces: number[];
  diag: number;
  epsilon: number;
  sourceFaces: number;
  componentAnalysisComplete: boolean;
}

class DisjointSet {
  private readonly parent: Int32Array;
  private readonly rank: Uint8Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    this.rank = new Uint8Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[value] !== value) {
      const next = this.parent[value];
      this.parent[value] = root;
      value = next;
    }
    return root;
  }

  union(a: number, b: number) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
  }
}

function prepareMesh(positions: Float32Array, index: Uint32Array | null, options: MeshHealthOptions): PreparedMesh {
  const bb = bboxOfPositions(positions);
  const diag = Math.hypot(
    bb.max[0] - bb.min[0],
    bb.max[1] - bb.min[1],
    bb.max[2] - bb.min[2],
  ) || 1;
  const epsilon = Math.max(1e-6, diag * 1e-5);
  const area2Epsilon = diag * diag * 2e-10;
  const sourceVertices = Math.floor(positions.length / 3);
  const weldMap = new Map<string, number>();
  const vertices: Vec3[] = [];
  const denseRemap = sourceVertices <= 1_000_000 ? new Int32Array(sourceVertices) : null;
  denseRemap?.fill(-1);
  const sparseRemap = denseRemap ? null : new Map<number, number>();
  const weldVertex = (source: number): number => {
    const known = denseRemap ? denseRemap[source] : sparseRemap!.get(source);
    if (known !== undefined && known >= 0) return known;
    const point: Vec3 = [positions[source * 3], positions[source * 3 + 1], positions[source * 3 + 2]];
    const key = `${Math.round(point[0] / epsilon)},${Math.round(point[1] / epsilon)},${Math.round(point[2] / epsilon)}`;
    let welded = weldMap.get(key);
    if (welded === undefined) {
      welded = vertices.length;
      weldMap.set(key, welded);
      vertices.push(point);
    }
    if (denseRemap) denseRemap[source] = welded;
    else sparseRemap!.set(source, welded);
    return welded;
  };

  const count = Math.floor((index ? index.length : sourceVertices) / 3);
  const componentLimit = Math.max(1, options.maxComponentAnalysisTriangles ?? MAX_COMPONENT_ANALYSIS_TRIANGLES);
  const componentAnalysisComplete = count <= componentLimit;
  const fallbackLimit = Math.max(1, options.maxSelfIntersectionTriangles ?? MAX_SELF_INTERSECTION_TRIANGLES);
  const processingCount = componentAnalysisComplete ? count : Math.min(count, fallbackLimit);
  const stride = componentAnalysisComplete ? 1 : count / processingCount;
  const triangles: Tri[] = [];
  const triangleSourceFaces: number[] = [];
  for (let sample = 0; sample < processingCount; sample++) {
    const face = componentAnalysisComplete ? sample : Math.min(count - 1, Math.floor(sample * stride));
    const raw: Tri = index
      ? [index[face * 3], index[face * 3 + 1], index[face * 3 + 2]]
      : [face * 3, face * 3 + 1, face * 3 + 2];
    if (raw[0] >= sourceVertices || raw[1] >= sourceVertices || raw[2] >= sourceVertices) continue;
    const tri: Tri = [weldVertex(raw[0]), weldVertex(raw[1]), weldVertex(raw[2])];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    const a = vertices[tri[0]];
    const b = vertices[tri[1]];
    const c = vertices[tri[2]];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (area2 < area2Epsilon) continue;
    triangles.push(tri);
    triangleSourceFaces.push(face);
  }
  return { vertices, triangles, triangleSourceFaces, diag, epsilon, sourceFaces: count, componentAnalysisComplete };
}

const PACK = 1 << 26;

interface Component {
  faces: number[];
  closed: boolean;
  min: Vec3;
  max: Vec3;
}

function componentsOf(mesh: PreparedMesh): Component[] {
  const { triangles, vertices } = mesh;
  if (!triangles.length) return [];
  const dsu = new DisjointSet(triangles.length);
  const usePacked = vertices.length < PACK;
  type EdgeKey = number | string;
  const edgeKey = (a: number, b: number): EdgeKey => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    return usePacked ? lo * PACK + hi : `${lo}_${hi}`;
  };
  const firstFaceByEdge = new Map<EdgeKey, number>();
  const boundaryEdges = new Set<EdgeKey>();
  const nonManifoldEdges = new Set<EdgeKey>();
  for (let face = 0; face < triangles.length; face++) {
    const [a, b, c] = triangles[face];
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const key = edgeKey(x, y);
      const first = firstFaceByEdge.get(key);
      if (first === undefined) {
        firstFaceByEdge.set(key, face);
        boundaryEdges.add(key);
      } else {
        dsu.union(first, face);
        if (boundaryEdges.has(key)) boundaryEdges.delete(key);
        else nonManifoldEdges.add(key);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let face = 0; face < triangles.length; face++) {
    const root = dsu.find(face);
    const group = groups.get(root);
    if (group) group.push(face);
    else groups.set(root, [face]);
  }

  const components: Component[] = [];
  for (const faces of groups.values()) {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let closed = true;
    for (const face of faces) {
      const tri = triangles[face];
      for (const id of tri) {
        const point = vertices[id];
        for (let axis = 0; axis < 3; axis++) {
          if (point[axis] < min[axis]) min[axis] = point[axis];
          if (point[axis] > max[axis]) max[axis] = point[axis];
        }
      }
      for (const [x, y] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]] as const) {
        const key = edgeKey(x, y);
        if (boundaryEdges.has(key) || nonManifoldEdges.has(key)) closed = false;
      }
    }
    components.push({ faces, closed, min, max });
  }
  return components.sort((a, b) => b.faces.length - a.faces.length);
}

function rayTriangleDistance(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3, epsilon: number): number | null {
  const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p: Vec3 = [
    direction[1] * e2[2] - direction[2] * e2[1],
    direction[2] * e2[0] - direction[0] * e2[2],
    direction[0] * e2[1] - direction[1] * e2[0],
  ];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) <= epsilon) return null;
  const inv = 1 / det;
  const t: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
  const u = (t[0] * p[0] + t[1] * p[1] + t[2] * p[2]) * inv;
  if (u < -epsilon || u > 1 + epsilon) return null;
  const q: Vec3 = [
    t[1] * e1[2] - t[2] * e1[1],
    t[2] * e1[0] - t[0] * e1[2],
    t[0] * e1[1] - t[1] * e1[0],
  ];
  const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * inv;
  if (v < -epsilon || u + v > 1 + epsilon) return null;
  const distance = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return distance > epsilon ? distance : null;
}

function pointInsideComponent(point: Vec3, component: Component, mesh: PreparedMesh): boolean {
  const direction: Vec3 = [0.91613, 0.33717, 0.21341];
  const distances: number[] = [];
  for (const face of component.faces) {
    const tri = mesh.triangles[face];
    const distance = rayTriangleDistance(
      point,
      direction,
      mesh.vertices[tri[0]],
      mesh.vertices[tri[1]],
      mesh.vertices[tri[2]],
      mesh.epsilon * 0.1,
    );
    if (distance !== null) distances.push(distance);
  }
  distances.sort((a, b) => a - b);
  let unique = 0;
  let previous = -Infinity;
  for (const distance of distances) {
    if (distance - previous > mesh.epsilon * 2) {
      unique++;
      previous = distance;
    }
  }
  return unique % 2 === 1;
}

function containsBounds(outer: Component, inner: Component, epsilon: number): boolean {
  return outer.min.every((value, axis) => value < inner.min[axis] - epsilon)
    && outer.max.every((value, axis) => value > inner.max[axis] + epsilon);
}

function internalComponentIndexes(components: Component[], mesh: PreparedMesh): Set<number> {
  const internal = new Set<number>();
  for (let candidate = 0; candidate < components.length; candidate++) {
    const inner = components[candidate];
    if (!inner.closed) continue;
    const point: Vec3 = [
      (inner.min[0] + inner.max[0]) / 2,
      (inner.min[1] + inner.max[1]) / 2,
      (inner.min[2] + inner.max[2]) / 2,
    ];
    for (let outerIndex = 0; outerIndex < components.length; outerIndex++) {
      if (outerIndex === candidate) continue;
      const outer = components[outerIndex];
      if (!outer.closed || !containsBounds(outer, inner, mesh.epsilon)) continue;
      if (pointInsideComponent(point, outer, mesh)) {
        internal.add(candidate);
        break;
      }
    }
  }
  return internal;
}

function connectedComponentEvidence(
  components: Component[],
  mesh: PreparedMesh,
  internal: Set<number>,
  fragments: Set<number>,
  options: MeshHealthOptions,
): { evidence: ConnectedComponentEvidence[]; complete: boolean } {
  if (!mesh.componentAnalysisComplete) return { evidence: [], complete: false };
  // 单壳资产没有“拆成现有零件”的预览价值，不为其复制最多 120k 个面索引。
  if (components.length <= 1) return { evidence: [], complete: true };
  const componentLimit = Math.max(1, options.maxComponentEvidence ?? MAX_COMPONENT_EVIDENCE);
  const visible = components.slice(0, componentLimit);
  let remainingFaces = Math.max(
    visible.length,
    options.maxComponentPreviewFaces ?? MAX_COMPONENT_PREVIEW_FACES,
  );
  const evidence: ConnectedComponentEvidence[] = [];
  for (let index = 0; index < visible.length; index++) {
    const component = visible[index];
    const remainingComponents = visible.length - index;
    const allowance = Math.max(1, Math.floor(remainingFaces / remainingComponents));
    const sampleCount = Math.min(component.faces.length, allowance);
    const stride = component.faces.length / sampleCount;
    const sourceFaceIndices: number[] = [];
    for (let sample = 0; sample < sampleCount; sample++) {
      const preparedFace = component.faces[Math.min(component.faces.length - 1, Math.floor(sample * stride))];
      sourceFaceIndices.push(mesh.triangleSourceFaces[preparedFace]);
    }
    remainingFaces -= sampleCount;
    evidence.push({
      componentIndex: index + 1,
      faceCount: component.faces.length,
      closed: component.closed,
      kind: index === 0 ? 'primary' : internal.has(index) ? 'internal' : fragments.has(index) ? 'fragment' : 'separate',
      bounds: { min: [...component.min], max: [...component.max] },
      sourceFaceIndices,
      previewComplete: sampleCount === component.faces.length,
    });
  }
  return {
    evidence,
    complete: components.length <= componentLimit && evidence.every((component) => component.previewComplete),
  };
}

interface TriangleBounds {
  face: number;
  min: Vec3;
  max: Vec3;
}

const orient2 = (a: [number, number], b: [number, number], c: [number, number]) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function project(point: Vec3, axis: number): [number, number] {
  if (axis === 0) return [point[1], point[2]];
  if (axis === 1) return [point[0], point[2]];
  return [point[0], point[1]];
}

function pointInTriangle2(point: [number, number], a: [number, number], b: [number, number], c: [number, number], eps: number): boolean {
  const o1 = orient2(a, b, point);
  const o2 = orient2(b, c, point);
  const o3 = orient2(c, a, point);
  return (o1 >= -eps && o2 >= -eps && o3 >= -eps) || (o1 <= eps && o2 <= eps && o3 <= eps);
}

function segmentsIntersect2(a: [number, number], b: [number, number], c: [number, number], d: [number, number], eps: number): boolean {
  const o1 = orient2(a, b, c);
  const o2 = orient2(a, b, d);
  const o3 = orient2(c, d, a);
  const o4 = orient2(c, d, b);
  if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps))
    && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) return true;
  const on = (p: [number, number], x: [number, number], y: [number, number]) =>
    Math.abs(orient2(x, y, p)) <= eps
    && p[0] >= Math.min(x[0], y[0]) - eps && p[0] <= Math.max(x[0], y[0]) + eps
    && p[1] >= Math.min(x[1], y[1]) - eps && p[1] <= Math.max(x[1], y[1]) + eps;
  return on(c, a, b) || on(d, a, b) || on(a, c, d) || on(b, c, d);
}

function coplanarTrianglesIntersect(a: Vec3[], b: Vec3[], normal: Vec3, epsilon: number): boolean {
  const axis = Math.abs(normal[0]) >= Math.abs(normal[1]) && Math.abs(normal[0]) >= Math.abs(normal[2])
    ? 0
    : Math.abs(normal[1]) >= Math.abs(normal[2]) ? 1 : 2;
  const pa = a.map((point) => project(point, axis));
  const pb = b.map((point) => project(point, axis));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (segmentsIntersect2(pa[i], pa[(i + 1) % 3], pb[j], pb[(j + 1) % 3], epsilon)) return true;
    }
  }
  return pointInTriangle2(pa[0], pb[0], pb[1], pb[2], epsilon)
    || pointInTriangle2(pb[0], pa[0], pa[1], pa[2], epsilon);
}

function segmentTriangleIntersects(start: Vec3, end: Vec3, tri: Vec3[], epsilon: number): boolean {
  const direction: Vec3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  const distance = rayTriangleDistance(start, direction, tri[0], tri[1], tri[2], epsilon);
  return distance !== null && distance <= 1 + epsilon;
}

function triangleIntersectsTriangle(a: Vec3[], b: Vec3[], epsilon: number): boolean {
  const ab: Vec3 = [a[1][0] - a[0][0], a[1][1] - a[0][1], a[1][2] - a[0][2]];
  const ac: Vec3 = [a[2][0] - a[0][0], a[2][1] - a[0][1], a[2][2] - a[0][2]];
  const normal: Vec3 = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const normalLength = Math.hypot(...normal);
  const planeDistance = Math.abs(
    normal[0] * (b[0][0] - a[0][0])
    + normal[1] * (b[0][1] - a[0][1])
    + normal[2] * (b[0][2] - a[0][2]),
  );
  if (normalLength > 0 && planeDistance <= epsilon * normalLength) {
    const distances = b.map((point) => Math.abs(
      normal[0] * (point[0] - a[0][0])
      + normal[1] * (point[1] - a[0][1])
      + normal[2] * (point[2] - a[0][2]),
    ));
    if (distances.every((distance) => distance <= epsilon * normalLength)) {
      return coplanarTrianglesIntersect(a, b, normal, epsilon);
    }
  }
  for (let edge = 0; edge < 3; edge++) {
    if (segmentTriangleIntersects(a[edge], a[(edge + 1) % 3], b, epsilon)) return true;
    if (segmentTriangleIntersects(b[edge], b[(edge + 1) % 3], a, epsilon)) return true;
  }
  return false;
}

function sharesVertex(a: Tri, b: Tri): boolean {
  return a[0] === b[0] || a[0] === b[1] || a[0] === b[2]
    || a[1] === b[0] || a[1] === b[1] || a[1] === b[2]
    || a[2] === b[0] || a[2] === b[1] || a[2] === b[2];
}

function selfIntersections(mesh: PreparedMesh, options: MeshHealthOptions) {
  const total = mesh.triangles.length;
  const limit = Math.max(1, options.maxSelfIntersectionTriangles ?? MAX_SELF_INTERSECTION_TRIANGLES);
  const stride = total > limit ? total / limit : 1;
  const selected: number[] = [];
  for (let sample = 0; sample < Math.min(total, limit); sample++) selected.push(Math.min(total - 1, Math.floor(sample * stride)));
  const bounds: TriangleBounds[] = selected.map((face) => {
    const points = mesh.triangles[face].map((id) => mesh.vertices[id]);
    return {
      face,
      min: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.min(...points.map((p) => p[2]))] as Vec3,
      max: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1])), Math.max(...points.map((p) => p[2]))] as Vec3,
    };
  }).sort((a, b) => a.min[0] - b.min[0]);

  const pairLimit = Math.max(1, options.maxSelfIntersectionPairTests ?? MAX_SELF_INTERSECTION_PAIR_TESTS);
  const hitLimit = Math.max(1, options.maxSelfIntersectionHits ?? MAX_SELF_INTERSECTION_HITS);
  const evidenceLimit = Math.max(1, options.maxSelfIntersectionEvidence ?? MAX_SELF_INTERSECTION_EVIDENCE);
  const evidence: SelfIntersectionEvidence[] = [];
  const active: TriangleBounds[] = [];
  const broadPhaseLimit = pairLimit * 10;
  let broadPhaseComparisons = 0;
  let pairTests = 0;
  let hits = 0;
  let truncated = mesh.sourceFaces > total || total > limit;
  outer: for (const current of bounds) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].max[0] < current.min[0] - mesh.epsilon) active.splice(i, 1);
    }
    for (const candidate of active) {
      broadPhaseComparisons++;
      if (broadPhaseComparisons > broadPhaseLimit) {
        truncated = true;
        break outer;
      }
      if (candidate.max[1] < current.min[1] - mesh.epsilon || current.max[1] < candidate.min[1] - mesh.epsilon
        || candidate.max[2] < current.min[2] - mesh.epsilon || current.max[2] < candidate.min[2] - mesh.epsilon) continue;
      const a = mesh.triangles[candidate.face];
      const b = mesh.triangles[current.face];
      if (sharesVertex(a, b)) continue;
      pairTests++;
      if (pairTests > pairLimit) {
        truncated = true;
        break outer;
      }
      if (triangleIntersectsTriangle(
        a.map((id) => mesh.vertices[id]),
        b.map((id) => mesh.vertices[id]),
        mesh.epsilon,
      )) {
        hits++;
        if (evidence.length < evidenceLimit) {
          const copyTriangle = (tri: Tri): [Vec3, Vec3, Vec3] => tri.map((id) => [...mesh.vertices[id]] as Vec3) as [Vec3, Vec3, Vec3];
          evidence.push({
            faceA: mesh.triangleSourceFaces[candidate.face] + 1,
            faceB: mesh.triangleSourceFaces[current.face] + 1,
            triangleA: copyTriangle(a),
            triangleB: copyTriangle(b),
          });
        }
        if (hits >= hitLimit) {
          truncated = true;
          break outer;
        }
      }
    }
    active.push(current);
  }
  return {
    pairs: hits,
    complete: !truncated,
    trianglesScanned: selected.length,
    pairTests: Math.min(pairTests, pairLimit),
    evidence,
  };
}

/**
 * M1.7.1 只读深度检查：所有结论都在检查 Worker 中计算，不修改几何。
 * 自交扫描受三角形数与候选对预算保护；未覆盖完整网格时 complete=false，UI 必须明确显示“部分检测”。
 */
export function analyzeMeshHealth(
  positions: Float32Array,
  index: Uint32Array | null,
  options: MeshHealthOptions = {},
): MeshHealthAnalysis {
  const mesh = prepareMesh(positions, index, options);
  const components = mesh.componentAnalysisComplete ? componentsOf(mesh) : [];
  const internal = internalComponentIndexes(components, mesh);
  const largestFaces = components[0]?.faces.length ?? 0;
  const overall = bboxOfPositions(positions);
  const overallDiag = Math.hypot(
    overall.max[0] - overall.min[0],
    overall.max[1] - overall.min[1],
    overall.max[2] - overall.min[2],
  ) || 1;
  let isolatedFragments = 0;
  let isolatedFragmentFaces = 0;
  const fragments = new Set<number>();
  for (let index = 1; index < components.length; index++) {
    if (internal.has(index)) continue;
    const component = components[index];
    const diagonal = Math.hypot(
      component.max[0] - component.min[0],
      component.max[1] - component.min[1],
      component.max[2] - component.min[2],
    );
    const faceRatio = largestFaces ? component.faces.length / largestFaces : 0;
    const lowFaceFragment = component.faces.length <= 12 && faceRatio <= 0.25;
    if (lowFaceFragment || faceRatio <= 0.01 || diagonal / overallDiag <= 0.03) {
      isolatedFragments++;
      isolatedFragmentFaces += component.faces.length;
      fragments.add(index);
    }
  }
  const componentPreview = connectedComponentEvidence(components, mesh, internal, fragments, options);
  const intersections = selfIntersections(mesh, options);
  return {
    connectedComponents: components.length,
    closedComponents: components.filter((component) => component.closed).length,
    componentAnalysisComplete: mesh.componentAnalysisComplete,
    componentEvidence: componentPreview.evidence,
    componentEvidenceComplete: componentPreview.complete,
    isolatedFragments,
    isolatedFragmentFaces,
    internalShells: internal.size,
    selfIntersectionPairs: intersections.pairs,
    selfIntersectionComplete: intersections.complete,
    selfIntersectionTrianglesScanned: intersections.trianglesScanned,
    selfIntersectionPairTests: intersections.pairTests,
    selfIntersectionEvidence: intersections.evidence,
  };
}
