import * as THREE from 'three';
import { bboxOfPositions, weldAndAnalyze, type Topology } from '../importer/parse-core';

type Vec3 = [number, number, number];
type Tri = [number, number, number];

export type MeshRepairStatus = 'ready' | 'unsupported' | 'not_needed';

export interface MeshRepairStats {
  before: Topology;
  after: Topology | null;
  sourceVertices: number;
  weldedVertices: number;
  removedDegenerateFaces: number;
  removedDuplicateFaces: number;
  filledHoles: number;
  addedFaces: number;
}

export interface MeshRepairPlan {
  status: MeshRepairStatus;
  reason: string | null;
  warnings: string[];
  actions: string[];
  stats: MeshRepairStats;
  repairedPositions: Float32Array | null;
  addedPositions: Float32Array;
  removedPositions: Float32Array;
}

const emptyAdded = () => new Float32Array(0);

function unsupported(before: Topology, sourceVertices: number, reason: string): MeshRepairPlan {
  return {
    status: 'unsupported',
    reason,
    warnings: [],
    actions: [],
    stats: {
      before,
      after: null,
      sourceVertices,
      weldedVertices: before.weldedVertices,
      removedDegenerateFaces: 0,
      removedDuplicateFaces: 0,
      filledHoles: 0,
      addedFaces: 0,
    },
    repairedPositions: null,
    addedPositions: emptyAdded(),
    removedPositions: emptyAdded(),
  };
}

const triArea2 = (a: Vec3, b: Vec3, c: Vec3) => {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
};

function newell(loop: number[], vertices: Vec3[]): THREE.Vector3 {
  const n = new THREE.Vector3();
  for (let i = 0; i < loop.length; i++) {
    const a = vertices[loop[i]];
    const b = vertices[loop[(i + 1) % loop.length]];
    n.x += (a[1] - b[1]) * (a[2] + b[2]);
    n.y += (a[2] - b[2]) * (a[0] + b[0]);
    n.z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

function dominantProjection(normal: THREE.Vector3, point: Vec3): THREE.Vector2 {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (ax >= ay && ax >= az) return new THREE.Vector2(point[1], point[2]);
  if (ay >= ax && ay >= az) return new THREE.Vector2(point[0], point[2]);
  return new THREE.Vector2(point[0], point[1]);
}

function positionsOf(triangles: Tri[], vertices: Vec3[]): Float32Array {
  const out = new Float32Array(triangles.length * 9);
  let offset = 0;
  for (const tri of triangles) {
    for (const id of tri) {
      out[offset++] = vertices[id][0];
      out[offset++] = vertices[id][1];
      out[offset++] = vertices[id][2];
    }
  }
  return out;
}

function signedVolume(triangles: Tri[], vertices: Vec3[]): number {
  let volume6 = 0;
  for (const [ia, ib, ic] of triangles) {
    const a = vertices[ia];
    const b = vertices[ib];
    const c = vertices[ic];
    volume6 += a[0] * (b[1] * c[2] - b[2] * c[1]);
    volume6 += a[1] * (b[2] * c[0] - b[0] * c[2]);
    volume6 += a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return volume6 / 6;
}

/**
 * M1.7A 的确定性修复范围：
 * - 按与检查器相同的容差焊接近重顶点；
 * - 删除塌缩/零面积三角形与完全重复面；
 * - 只封闭由一致有向边组成、最多 128 个顶点且近似共面的简单边界环；
 * - 任何非流形边、开放链、非平面孔或零体积结果都 fail-closed。
 */
export function planMeshRepair(positions: Float32Array, index: Uint32Array | null): MeshRepairPlan {
  const before = weldAndAnalyze(positions, index);
  const sourceVertices = positions.length / 3;
  if (sourceVertices < 3) return unsupported(before, sourceVertices, '网格没有足够的三角形，无法生成安全修复。');
  if (before.nonManifoldEdges > 0) {
    return unsupported(before, sourceVertices, `检测到 ${before.nonManifoldEdges} 条非流形边；自动补面可能改变拓扑连接，当前版本不会尝试。`);
  }

  const bb = bboxOfPositions(positions);
  const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
  const eps = Math.max(1e-6, diag * 1e-5);
  const area2Eps = diag * diag * 2e-10;
  const weldMap = new Map<string, number>();
  const vertices: Vec3[] = [];
  const remap = new Uint32Array(sourceVertices);
  for (let i = 0; i < sourceVertices; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const key = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    let id = weldMap.get(key);
    if (id === undefined) {
      id = vertices.length;
      weldMap.set(key, id);
      vertices.push([x, y, z]);
    }
    remap[i] = id;
  }

  const inputTriCount = Math.floor((index ? index.length : sourceVertices) / 3);
  const triangles: Tri[] = [];
  const triangleKeys = new Set<string>();
  const removed: number[] = [];
  let removedDegenerateFaces = 0;
  let removedDuplicateFaces = 0;
  for (let t = 0; t < inputTriCount; t++) {
    const raw: Tri = index
      ? [index[t * 3], index[t * 3 + 1], index[t * 3 + 2]]
      : [t * 3, t * 3 + 1, t * 3 + 2];
    if (raw.some((id) => id >= sourceVertices)) {
      return unsupported(before, sourceVertices, '网格索引超出顶点范围，无法安全修复。');
    }
    const tri: Tri = [remap[raw[0]], remap[raw[1]], remap[raw[2]]];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]
      || triArea2(vertices[tri[0]], vertices[tri[1]], vertices[tri[2]]) < area2Eps) {
      removedDegenerateFaces++;
      for (const id of raw) removed.push(positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]);
      continue;
    }
    const key = [...tri].sort((a, b) => a - b).join('_');
    if (triangleKeys.has(key)) {
      removedDuplicateFaces++;
      for (const id of raw) removed.push(positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]);
      continue;
    }
    triangleKeys.add(key);
    triangles.push(tri);
  }
  if (!triangles.length) return unsupported(before, sourceVertices, '清理退化面后没有剩余有效三角形。');

  type Edge = { a: number; b: number; count: number };
  const edges = new Map<string, Edge>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (const [a, b, c] of triangles) {
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
      const key = edgeKey(from, to);
      const edge = edges.get(key);
      if (edge) edge.count += 1;
      else edges.set(key, { a: from, b: to, count: 1 });
    }
  }
  const nonManifoldAfterCleanup = [...edges.values()].filter((edge) => edge.count > 2).length;
  if (nonManifoldAfterCleanup) {
    return unsupported(before, sourceVertices, `清理后仍有 ${nonManifoldAfterCleanup} 条非流形边，当前版本不会自动改写连接关系。`);
  }

  const boundary = [...edges.values()].filter((edge) => edge.count === 1);
  const loops: number[][] = [];
  if (boundary.length) {
    const outgoing = new Map<number, number>();
    const incoming = new Map<number, number>();
    for (const edge of boundary) {
      if (outgoing.has(edge.a) || incoming.has(edge.b)) {
        return unsupported(before, sourceVertices, '开放边界不是单一闭环，可能存在分叉或法线绕序冲突。');
      }
      outgoing.set(edge.a, edge.b);
      incoming.set(edge.b, edge.a);
    }
    if ([...outgoing.keys()].some((id) => !incoming.has(id))) {
      return unsupported(before, sourceVertices, '检测到开放边界链而不是闭合孔洞，无法安全补面。');
    }
    const unvisited = new Set([...outgoing.keys()].map((id) => `${id}>${outgoing.get(id)!}`));
    while (unvisited.size) {
      const first = unvisited.values().next().value as string;
      const start = Number(first.split('>')[0]);
      const loop = [start];
      let current = start;
      for (let guard = 0; guard <= boundary.length; guard++) {
        const next = outgoing.get(current);
        if (next === undefined) return unsupported(before, sourceVertices, '边界环在遍历时中断，无法安全补面。');
        unvisited.delete(`${current}>${next}`);
        current = next;
        if (current === start) break;
        loop.push(current);
      }
      if (current !== start || loop.length < 3) return unsupported(before, sourceVertices, '边界无法组成有效闭环。');
      if (loop.length > 128) return unsupported(before, sourceVertices, `孔洞边界包含 ${loop.length} 个顶点，超过当前安全上限 128。`);
      loops.push(loop);
    }
  }

  const addedTriangles: Tri[] = [];
  const planarTolerance = Math.max(1e-5, diag * 1e-4);
  for (const sourceLoop of loops) {
    const sourceNormal = newell(sourceLoop, vertices);
    if (sourceNormal.lengthSq() < 1e-16) return unsupported(before, sourceVertices, '孔洞边界法线不稳定，无法确定补面方向。');
    sourceNormal.normalize();
    const center = sourceLoop.reduce((sum, id) => sum.add(new THREE.Vector3(...vertices[id])), new THREE.Vector3()).multiplyScalar(1 / sourceLoop.length);
    const maxDeviation = Math.max(...sourceLoop.map((id) => Math.abs(new THREE.Vector3(...vertices[id]).sub(center).dot(sourceNormal))));
    if (maxDeviation > planarTolerance) {
      return unsupported(before, sourceVertices, `孔洞边界不是近似平面（最大偏差 ${maxDeviation.toFixed(3)}mm），自动封口可能扭曲表面。`);
    }

    // 新补面的边界绕序必须与原面相反，才能形成方向一致的双邻接边。
    const capLoop = [...sourceLoop].reverse();
    const capNormal = newell(capLoop, vertices).normalize();
    const contour = capLoop.map((id) => dominantProjection(capNormal, vertices[id]));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    if (faces.length !== capLoop.length - 2) {
      return unsupported(before, sourceVertices, '孔洞轮廓可能自交，三角化没有生成完整封口。');
    }
    for (const [ia, ib, ic] of faces) {
      let tri: Tri = [capLoop[ia], capLoop[ib], capLoop[ic]];
      const a = new THREE.Vector3(...vertices[tri[0]]);
      const b = new THREE.Vector3(...vertices[tri[1]]);
      const c = new THREE.Vector3(...vertices[tri[2]]);
      const normal = b.clone().sub(a).cross(c.clone().sub(a));
      if (normal.dot(capNormal) < 0) tri = [tri[0], tri[2], tri[1]];
      addedTriangles.push(tri);
    }
  }

  const repairedTriangles = [...triangles, ...addedTriangles];
  const repairedPositions = positionsOf(repairedTriangles, vertices);
  const after = weldAndAnalyze(repairedPositions, null);
  if (!after.watertight) {
    return unsupported(before, sourceVertices, `尝试修复后仍有 ${after.boundaryEdges} 条开放边和 ${after.nonManifoldEdges} 条非流形边，已放弃结果。`);
  }
  const bboxVolume = Math.max(0,
    (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]) * (bb.max[2] - bb.min[2]));
  if (Math.abs(signedVolume(repairedTriangles, vertices)) < Math.max(1e-9, bboxVolume * 1e-8)) {
    return unsupported(before, sourceVertices, '修复结果没有稳定的封闭体积，可能只是重叠薄片，已放弃结果。');
  }

  const actions: string[] = [];
  const welded = sourceVertices - vertices.length;
  if (welded > 0) actions.push(`拓扑焊接 ${welded.toLocaleString()} 个重复或近重顶点`);
  if (removedDegenerateFaces) actions.push(`删除 ${removedDegenerateFaces} 个退化面`);
  if (removedDuplicateFaces) actions.push(`删除 ${removedDuplicateFaces} 个重复面`);
  if (loops.length) actions.push(`封闭 ${loops.length} 个平面边界环，新增 ${addedTriangles.length} 个面`);
  if (!actions.length) {
    return {
      status: 'not_needed',
      reason: '当前网格已经满足本版本可验证的修复条件，无需生成副本。',
      warnings: [],
      actions: [],
      stats: {
        before,
        after: before,
        sourceVertices,
        weldedVertices: vertices.length,
        removedDegenerateFaces: 0,
        removedDuplicateFaces: 0,
        filledHoles: 0,
        addedFaces: 0,
      },
      repairedPositions: null,
      addedPositions: emptyAdded(),
      removedPositions: emptyAdded(),
    };
  }

  return {
    status: 'ready',
    reason: null,
    warnings: loops.length ? ['补面会封闭开口；如果开口本来就是设计意图，请取消并保留原模型。'] : [],
    actions,
    stats: {
      before,
      after,
      sourceVertices,
      weldedVertices: vertices.length,
      removedDegenerateFaces,
      removedDuplicateFaces,
      filledHoles: loops.length,
      addedFaces: addedTriangles.length,
    },
    repairedPositions,
    addedPositions: positionsOf(addedTriangles, vertices),
    removedPositions: new Float32Array(removed),
  };
}
