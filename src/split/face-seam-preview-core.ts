import * as THREE from 'three';
import {
  buildFacePaintTopology,
  paintedFaceCount,
  type FacePaintEdge,
  type FacePaintTopology,
} from './face-paint-core';
import { projectSeamLoop } from './seam-projection-core';

export type FaceSeamIssueCode =
  | 'empty_selection'
  | 'full_selection'
  | 'boundary_budget'
  | 'source_open'
  | 'source_nonmanifold'
  | 'open_boundary'
  | 'branched_boundary'
  | 'multiple_loops'
  | 'degenerate_loop'
  | 'self_intersection';

export type FaceSeamWarningCode = 'cap_warp' | 'thin_part' | 'tiny_part';

export interface FaceSeamMessage<TCode extends string> {
  code: TCode;
  title: string;
  detail: string;
}

export interface FaceSeamMetrics {
  paintedFaces: number;
  remainingFaces: number;
  paintedRatio: number;
  boundaryVertices: number;
  seamLengthMm: number;
  maxPlanarityDeviationMm: number;
  selectionMinDimensionMm: number;
  selectionMaxDimensionMm: number;
  componentCount: number;
}

export interface FaceSeamPreviewResult {
  status: 'ready' | 'invalid';
  loopPositions: Float32Array;
  issues: FaceSeamMessage<FaceSeamIssueCode>[];
  warnings: FaceSeamMessage<FaceSeamWarningCode>[];
  metrics: FaceSeamMetrics;
}

interface BoundaryGraph {
  edges: FacePaintEdge[];
  adjacency: Map<number, number[]>;
  components: number[][];
}

const EMPTY_METRICS: FaceSeamMetrics = {
  paintedFaces: 0,
  remainingFaces: 0,
  paintedRatio: 0,
  boundaryVertices: 0,
  seamLengthMm: 0,
  maxPlanarityDeviationMm: 0,
  selectionMinDimensionMm: 0,
  selectionMaxDimensionMm: 0,
  componentCount: 0,
};

function message<TCode extends string>(
  code: TCode,
  title: string,
  detail: string,
): FaceSeamMessage<TCode> {
  return { code, title, detail };
}

export function createShellGroupPreview(
  mask: Uint8Array,
  selectedShellCount: number,
): FaceSeamPreviewResult {
  const paintedFaces = paintedFaceCount(mask);
  const remainingFaces = Math.max(0, mask.length - paintedFaces);
  const valid = paintedFaces > 0 && remainingFaces > 0 && selectedShellCount > 0;
  return {
    status: valid ? 'ready' : 'invalid',
    loopPositions: new Float32Array(0),
    issues: valid
      ? []
      : [message(
        'degenerate_loop',
        '没有可独立拆出的壳体',
        '粗涂必须至少命中一个与主体分离的完整网格壳体。',
      )],
    warnings: [],
    metrics: {
      ...EMPTY_METRICS,
      paintedFaces,
      remainingFaces,
      paintedRatio: mask.length > 0 ? paintedFaces / mask.length : 0,
      componentCount: selectedShellCount,
    },
  };
}

function boundaryGraph(topology: FacePaintTopology, mask: Uint8Array): BoundaryGraph {
  const edges = topology.edges.filter((edge) => {
    let painted = 0;
    for (const faceIndex of edge.faces) painted += mask[faceIndex] ? 1 : 0;
    return painted > 0 && painted < edge.faces.length;
  });
  const adjacency = new Map<number, number[]>();
  edges.forEach((edge, edgeIndex) => {
    for (const vertexId of [edge.idA, edge.idB]) {
      const adjacent = adjacency.get(vertexId);
      if (adjacent) adjacent.push(edgeIndex);
      else adjacency.set(vertexId, [edgeIndex]);
    }
  });
  const components: number[][] = [];
  const visited = new Set<number>();
  edges.forEach((_, startEdge) => {
    if (visited.has(startEdge)) return;
    const component: number[] = [];
    const queue = [startEdge];
    visited.add(startEdge);
    while (queue.length) {
      const edgeIndex = queue.shift()!;
      component.push(edgeIndex);
      const edge = edges[edgeIndex];
      for (const vertexId of [edge.idA, edge.idB]) {
        for (const neighbor of adjacency.get(vertexId) ?? []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  });
  return { edges, adjacency, components };
}

function orderedLoopIds(graph: BoundaryGraph): number[] {
  if (graph.components.length !== 1 || graph.edges.length < 3) return [];
  const startEdgeIndex = graph.components[0][0];
  const startEdge = graph.edges[startEdgeIndex];
  const loop = [startEdge.idA];
  let currentVertex = startEdge.idB;
  let previousEdge = startEdgeIndex;
  const used = new Set<number>([startEdgeIndex]);
  while (currentVertex !== loop[0]) {
    loop.push(currentVertex);
    const nextEdge = (graph.adjacency.get(currentVertex) ?? [])
      .find((edgeIndex) => edgeIndex !== previousEdge && !used.has(edgeIndex));
    if (nextEdge === undefined) return [];
    used.add(nextEdge);
    const edge = graph.edges[nextEdge];
    currentVertex = edge.idA === currentVertex ? edge.idB : edge.idA;
    previousEdge = nextEdge;
    if (used.size > graph.edges.length) return [];
  }
  return used.size === graph.edges.length ? loop : [];
}

function localPositions(topology: FacePaintTopology, vertexIds: number[]): Float32Array {
  const values = new Float32Array(vertexIds.length * 3);
  vertexIds.forEach((vertexId, index) => {
    values[index * 3] = topology.vertexPositions[vertexId * 3];
    values[index * 3 + 1] = topology.vertexPositions[vertexId * 3 + 1];
    values[index * 3 + 2] = topology.vertexPositions[vertexId * 3 + 2];
  });
  return values;
}

function worldLoopPoints(
  positions: Float32Array,
  worldMatrix: THREE.Matrix4,
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    points.push(new THREE.Vector3(
      positions[index],
      positions[index + 1],
      positions[index + 2],
    ).applyMatrix4(worldMatrix));
  }
  return points;
}

function loopLength(points: THREE.Vector3[]): number {
  if (points.length < 2) return 0;
  let length = 0;
  for (let index = 0; index < points.length; index += 1) {
    length += points[index].distanceTo(points[(index + 1) % points.length]);
  }
  return length;
}

function newellNormal(points: THREE.Vector3[]): THREE.Vector3 {
  const normal = new THREE.Vector3();
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    normal.x += (current.y - next.y) * (current.z + next.z);
    normal.y += (current.z - next.z) * (current.x + next.x);
    normal.z += (current.x - next.x) * (current.y + next.y);
  }
  return normal;
}

function planarityDeviation(points: THREE.Vector3[], normal: THREE.Vector3): number {
  if (points.length < 3 || normal.lengthSq() < 1e-16) return 0;
  const centroid = points
    .reduce((sum, point) => sum.add(point), new THREE.Vector3())
    .multiplyScalar(1 / points.length);
  const unitNormal = normal.clone().normalize();
  let maximum = 0;
  for (const point of points) {
    maximum = Math.max(maximum, Math.abs(point.clone().sub(centroid).dot(unitNormal)));
  }
  return maximum;
}

function selectionDimensions(
  topology: FacePaintTopology,
  mask: Uint8Array,
  worldMatrix: THREE.Matrix4,
): [number, number] {
  const position = topology.geometry.getAttribute('position');
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  const indexAt = (cornerIndex: number) => (
    topology.geometry.index ? topology.geometry.index.getX(cornerIndex) : cornerIndex
  );
  for (let faceIndex = 0; faceIndex < topology.faceCount; faceIndex += 1) {
    if (!mask[faceIndex]) continue;
    for (let corner = 0; corner < 3; corner += 1) {
      point.fromBufferAttribute(position, indexAt(faceIndex * 3 + corner)).applyMatrix4(worldMatrix);
      box.expandByPoint(point);
    }
  }
  if (box.isEmpty()) return [0, 0];
  const size = box.getSize(new THREE.Vector3());
  return [
    Math.min(size.x, size.y, size.z),
    Math.max(size.x, size.y, size.z),
  ];
}

export function createFaceSeamPreview(
  topology: FacePaintTopology | null,
  mask: Uint8Array,
  worldMatrix = new THREE.Matrix4(),
): FaceSeamPreviewResult {
  const paintedFaces = paintedFaceCount(mask);
  const totalFaces = topology?.faceCount ?? mask.length;
  const metrics: FaceSeamMetrics = {
    ...EMPTY_METRICS,
    paintedFaces,
    remainingFaces: Math.max(0, totalFaces - paintedFaces),
    paintedRatio: totalFaces > 0 ? paintedFaces / totalFaces : 0,
  };
  const issues: FaceSeamMessage<FaceSeamIssueCode>[] = [];
  const warnings: FaceSeamMessage<FaceSeamWarningCode>[] = [];
  if (paintedFaces === 0) {
    issues.push(message('empty_selection', '还没有面组', '先在模型上涂出准备拆下的区域。'));
  }
  if (totalFaces > 0 && paintedFaces === totalFaces) {
    issues.push(message('full_selection', '整个模型都被选中', '至少保留一部分未涂面，才能形成 A / B 接缝。'));
  }
  if (!topology) {
    issues.push(message(
      'boundary_budget',
      '局部接缝超过当前处理范围',
      '首版支持模型总面数 200 万以内、自动补全后面组 50 万面以内；请缩小到一个关节区域后重试。',
    ));
    return {
      status: 'invalid',
      loopPositions: new Float32Array(0),
      issues,
      warnings,
      metrics,
    };
  }

  const graph = boundaryGraph(topology, mask);
  metrics.componentCount = graph.components.length;
  metrics.boundaryVertices = graph.adjacency.size;
  if (paintedFaces > 0 && paintedFaces < totalFaces && graph.edges.length === 0) {
    issues.push(message(
      'degenerate_loop',
      '面组与剩余模型没有共享接缝',
      '所选区域可能已经是独立壳体；请使用连通壳拆件，或重画跨越同一连续表面的区域。',
    ));
  }
  const selectedOpenEdges = topology.edges.filter(
    (edge) => edge.faces.length === 1 && edge.faces.some((faceIndex) => mask[faceIndex]),
  );
  const selectedNonmanifoldEdges = topology.edges.filter(
    (edge) => edge.faces.length > 2 && edge.faces.some((faceIndex) => mask[faceIndex]),
  );
  if (selectedOpenEdges.length) {
    issues.push(message(
      'source_open',
      '面组接触到源网格开放边',
      `检测到 ${selectedOpenEdges.length} 条开放边；先修复水密性，否则无法可靠封口。`,
    ));
  }
  if (selectedNonmanifoldEdges.length) {
    issues.push(message(
      'source_nonmanifold',
      '面组接触到非流形边',
      `检测到 ${selectedNonmanifoldEdges.length} 条非流形边；先修复拓扑再生成接缝。`,
    ));
  }
  const degreeOne = [...graph.adjacency.values()].filter((edges) => edges.length === 1).length;
  const branched = [...graph.adjacency.values()].filter((edges) => edges.length > 2).length;
  if (degreeOne) {
    issues.push(message(
      'open_boundary',
      '接缝没有闭合',
      `有 ${degreeOne} 个断点；补涂或擦除断点附近，直到黄色边界形成完整一圈。`,
    ));
  }
  if (branched) {
    issues.push(message(
      'branched_boundary',
      '接缝出现分叉',
      `有 ${branched} 个分叉点；擦除多余分支，只保留一条连续边界。`,
    ));
  }
  if (graph.components.length > 1) {
    issues.push(message(
      'multiple_loops',
      '检测到多个独立接缝',
      `当前有 ${graph.components.length} 个环；M1.11b 每次只允许预览一个闭环。`,
    ));
  }

  const loopIds = issues.some((issue) => (
    issue.code === 'open_boundary'
    || issue.code === 'branched_boundary'
    || issue.code === 'multiple_loops'
  ))
    ? []
    : orderedLoopIds(graph);
  const loopPositions = localPositions(topology, loopIds);
  const worldPoints = worldLoopPoints(loopPositions, worldMatrix);
  const normal = newellNormal(worldPoints);
  if (graph.edges.length > 0 && (loopIds.length < 3 || normal.lengthSq() < 1e-12)) {
    issues.push(message(
      'degenerate_loop',
      '接缝形状退化',
      '闭环面积过小或边界重合，请扩大面组后重试。',
    ));
  } else if (
    worldPoints.length >= 4
    && projectSeamLoop(
      worldPoints.map((point) => [point.x, point.y, point.z]),
    ).status === 'self_intersection'
  ) {
    issues.push(message(
      'self_intersection',
      '接缝发生自相交',
      '候选边界在实际封口平面中交叉；已拒绝生成可能破裂的封口。',
    ));
  }

  metrics.seamLengthMm = loopLength(worldPoints);
  metrics.maxPlanarityDeviationMm = planarityDeviation(worldPoints, normal);
  [metrics.selectionMinDimensionMm, metrics.selectionMaxDimensionMm] = selectionDimensions(
    topology,
    mask,
    worldMatrix,
  );
  const loopBox = new THREE.Box3().setFromPoints(worldPoints);
  const loopDiameter = loopBox.isEmpty() ? 0 : loopBox.getSize(new THREE.Vector3()).length();
  const warpThreshold = Math.max(0.35, loopDiameter * 0.025);
  if (metrics.maxPlanarityDeviationMm > warpThreshold) {
    warnings.push(message(
      'cap_warp',
      '封口不是平面',
      `最大偏离 ${metrics.maxPlanarityDeviationMm.toFixed(2)} mm；真实切割需要曲面封口或重新拟合。`,
    ));
  }
  if (
    metrics.selectionMaxDimensionMm > 3
    && metrics.selectionMinDimensionMm < Math.max(0.8, metrics.selectionMaxDimensionMm * 0.012)
  ) {
    warnings.push(message(
      'thin_part',
      '拆下部分可能过薄',
      `最薄包围尺寸约 ${metrics.selectionMinDimensionMm.toFixed(2)} mm，打印和封口风险较高。`,
    ));
  }
  if (metrics.paintedRatio > 0 && (metrics.paintedRatio < 0.01 || metrics.paintedRatio > 0.99)) {
    warnings.push(message(
      'tiny_part',
      '一侧零件占比过小',
      `面数占比约 ${(Math.min(metrics.paintedRatio, 1 - metrics.paintedRatio) * 100).toFixed(1)}%，请确认不是误涂。`,
    ));
  }

  return {
    status: issues.length ? 'invalid' : 'ready',
    loopPositions,
    issues,
    warnings,
    metrics,
  };
}

export function createFaceSeamPreviewFromGeometry(
  geometry: THREE.BufferGeometry,
  mask: Uint8Array,
  worldMatrix?: THREE.Matrix4,
): FaceSeamPreviewResult {
  return createFaceSeamPreview(buildFacePaintTopology(geometry), mask, worldMatrix);
}
