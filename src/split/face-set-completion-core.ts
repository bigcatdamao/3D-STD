import { projectSeamLoop, type SeamPoint3 } from './seam-projection-core';

export const FACE_SET_COMPLETION_SOURCE_FACE_BUDGET = 2_000_000;
export const FACE_SET_COMPLETION_CANDIDATE_LIMIT = 64;
export const FACE_SET_COMPLETION_SELECTED_FACE_BUDGET = 500_000;
export const FACE_SET_COMPLETION_MAX_EXPANSION = 4;
export const FACE_SET_COMPLETION_MAX_MODEL_RATIO = 0.85;
export const FACE_SET_COMPLETION_MIN_ROUGH_RECALL = 0.6;
export const FACE_SET_COMPLETION_BRIDGE_MAX_COVERAGE = 0.65;
export const FACE_SET_COMPLETION_CAP_CANDIDATE_LIMIT = 8;
export const FACE_SET_COMPLETION_CAP_CONTOUR_BUDGET = 12_000;
export const FACE_SET_COMPLETION_GROWTH_STEPS = [
  2, 4, 8, 16, 32, 64, 96, 128, 192, 256, 384, 512,
] as const;

export interface FaceSetCompletionSummary {
  candidateCount: number;
  branchPoints: number;
  roughFaces: number;
  completedFaces: number;
  addedFaces: number;
  removedFaces: number;
  matchPercent: number;
  seamEdges: number;
  seamLengthLocal: number;
  searchMode: 'rough_boundary' | 'seed_growth';
  growthRings: number;
  splitMode: 'surface' | 'hybrid' | 'shells';
  sourceShellCount: number;
  selectedShellCount: number;
  fullShellFaces: number;
  bridgeShellFaces: number;
  anchorDistanceMm?: number;
  optionIndex?: number;
  optionCount?: number;
}

export interface FaceSetCompletionOption {
  faceLabels: Uint8Array;
  loopPositions: Float32Array;
  summary: FaceSetCompletionSummary;
}

export type FaceSetCompletionResult =
  | {
    status: 'ready';
    faceLabels: Uint8Array;
    loopPositions: Float32Array;
    summary: FaceSetCompletionSummary;
    alternatives?: FaceSetCompletionOption[];
  }
  | {
    status: 'invalid';
    code:
      | 'budget'
      | 'invalid_geometry'
      | 'no_closed_candidate'
      | 'ambiguous_candidate'
      | 'unsafe_expansion';
    message: string;
    details?: Record<string, number>;
  };

interface BoundaryEdge {
  a: number;
  b: number;
  halfA: number;
  halfB: number;
  selectedHalf: number;
}

interface CandidateLoop {
  barrierHalves: number[];
  startFace: number;
  vertexIds: number[];
  seamLength: number;
  componentFaces: number;
  roughInside: number;
  match: number;
  score: number;
  growthRings: number;
  projectionSafe: boolean | null;
  anchorDistanceMm: number;
}

const PACK = 1 << 26;

function invalid(
  code: Extract<FaceSetCompletionResult, { status: 'invalid' }>['code'],
  message: string,
  details?: Record<string, number>,
): FaceSetCompletionResult {
  return { status: 'invalid', code, message, details };
}

/**
 * Convert a visible rough paint mask into one complete side of a single closed
 * seam. The worker builds a transient compact face adjacency graph, extracts
 * candidate loops, and ranks each loop by how well its selected side overlaps
 * the user's rough paint. If the visible rough boundary is not already a safe
 * seam, a view-aware graph search expands preferentially through back-facing
 * triangles and samples progressively larger joint rings. The winning loop
 * becomes a hard barrier; flood fill then includes hidden/back faces without
 * asking the user to paint every triangle.
 */
export function completeFaceSetFromRoughMask(
  positions: Float32Array,
  index: Uint32Array | null,
  roughMask: Uint8Array,
  sourceFaceBudget = FACE_SET_COMPLETION_SOURCE_FACE_BUDGET,
  viewPositionLocal: readonly number[] | null = null,
  worldMatrix: readonly number[] | null = null,
  seamAnchorLocal: readonly number[] | null = null,
): FaceSetCompletionResult {
  const sourceVertices = Math.floor(positions.length / 3);
  const faceCount = Math.floor((index ? index.length : sourceVertices) / 3);
  if (!sourceVertices || !faceCount || roughMask.length !== faceCount) {
    return invalid('invalid_geometry', '粗涂面组与当前网格面数不一致');
  }
  if (faceCount > sourceFaceBudget) {
    return invalid(
      'budget',
      `模型共 ${faceCount.toLocaleString()} 面，超过粗涂自动补全 ${sourceFaceBudget.toLocaleString()} 面预算`,
      { faceCount, sourceFaceBudget },
    );
  }
  let roughFaces = 0;
  for (let face = 0; face < faceCount; face += 1) {
    const value = Number(roughMask[face]);
    if (value !== 0 && value !== 1) {
      return invalid('invalid_geometry', `粗涂面组 #${face} 的标签无效`);
    }
    roughFaces += value;
  }
  if (!roughFaces || roughFaces === faceCount) {
    return invalid('invalid_geometry', '粗涂区域必须只覆盖模型的一部分');
  }
  const adaptiveFaceLimit = Math.min(
    FACE_SET_COMPLETION_SELECTED_FACE_BUDGET,
    Math.floor(faceCount * FACE_SET_COMPLETION_MAX_MODEL_RATIO),
    Math.max(
      Math.ceil(roughFaces * FACE_SET_COMPLETION_MAX_EXPANSION),
      roughFaces + 20_000,
    ),
  );
  if (roughFaces > adaptiveFaceLimit) {
    return invalid(
      'unsafe_expansion',
      '当前粗涂已经覆盖过大的模型区域，已保留原始粗涂；请只保留准备拆下的一个零件',
      {
        roughFaces,
        proposedFaces: roughFaces,
        safeFaceLimit: adaptiveFaceLimit,
      },
    );
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < sourceVertices; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = Number(positions[vertex * 3 + axis]);
      if (!Number.isFinite(value)) {
        return invalid('invalid_geometry', `顶点 #${vertex} 含无效坐标`);
      }
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  const diagonal = Math.max(Math.hypot(
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ), 1);
  const epsilon = Math.max(1e-6, diagonal * 1e-5);
  const inverse = 1 / epsilon;

  // Imported meshes are intentionally non-indexed. Weld once in the worker and
  // keep only a 32-bit remap; the string map is released after adjacency build.
  const weldMap = new Map<string, number>();
  const remap = new Uint32Array(sourceVertices);
  const representativeSource: number[] = [];
  let weldedVertices = 0;
  for (let vertex = 0; vertex < sourceVertices; vertex += 1) {
    const offset = vertex * 3;
    const key = `${Math.round(positions[offset] * inverse)},${Math.round(positions[offset + 1] * inverse)},${Math.round(positions[offset + 2] * inverse)}`;
    let welded = weldMap.get(key);
    if (welded === undefined) {
      welded = weldedVertices++;
      if (welded >= PACK) {
        return invalid('budget', '焊接顶点数量超过当前紧凑拓扑编码范围');
      }
      weldMap.set(key, welded);
      representativeSource.push(vertex);
    }
    remap[vertex] = welded;
  }

  const originalIndex = (face: number, corner: number): number => Number(
    index ? index[face * 3 + corner] : face * 3 + corner,
  );
  const opposite = new Int32Array(faceCount * 3);
  opposite.fill(-1);
  const pending = new Map<number, number>();
  const packedEdge = (a: number, b: number) => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    return lo * PACK + hi;
  };
  for (let face = 0; face < faceCount; face += 1) {
    const source: [number, number, number] = [
      originalIndex(face, 0),
      originalIndex(face, 1),
      originalIndex(face, 2),
    ];
    if (source.some((vertex) => !Number.isInteger(vertex) || vertex < 0 || vertex >= sourceVertices)) {
      return invalid('invalid_geometry', `三角面 #${face} 的顶点索引无效`);
    }
    const vertices: [number, number, number] = [
      remap[source[0]],
      remap[source[1]],
      remap[source[2]],
    ];
    if (new Set(vertices).size < 3) continue;
    for (let edge = 0; edge < 3; edge += 1) {
      const half = face * 3 + edge;
      const key = packedEdge(vertices[edge], vertices[(edge + 1) % 3]);
      const other = pending.get(key);
      if (other === undefined) {
        pending.set(key, half);
      } else {
        opposite[half] = other;
        opposite[other] = half;
        pending.delete(key);
      }
    }
  }
  weldMap.clear();
  pending.clear();

  const componentId = new Int32Array(faceCount);
  componentId.fill(-1);
  const componentFaceCounts: number[] = [];
  const componentRoughCounts: number[] = [];
  const componentQueue = new Int32Array(faceCount);
  for (let start = 0; start < faceCount; start += 1) {
    if (componentId[start] >= 0) continue;
    const id = componentFaceCounts.length;
    let head = 0;
    let tail = 1;
    let componentRoughFaces = 0;
    componentQueue[0] = start;
    componentId[start] = id;
    while (head < tail) {
      const face = componentQueue[head++];
      componentRoughFaces += roughMask[face] ? 1 : 0;
      for (let edge = 0; edge < 3; edge += 1) {
        const otherHalf = opposite[face * 3 + edge];
        if (otherHalf < 0) continue;
        const neighbor = Math.floor(otherHalf / 3);
        if (componentId[neighbor] >= 0) continue;
        componentId[neighbor] = id;
        componentQueue[tail++] = neighbor;
      }
    }
    componentFaceCounts.push(tail);
    componentRoughCounts.push(componentRoughFaces);
  }

  const paintedComponents = componentFaceCounts
    .map((_count, id) => id)
    .filter((id) => componentRoughCounts[id] > 0);
  let bridgeComponent = -1;
  if (componentFaceCounts.length === 1) {
    bridgeComponent = 0;
  } else {
    let anchorComponent = 0;
    for (let id = 1; id < componentFaceCounts.length; id += 1) {
      if (componentFaceCounts[id] > componentFaceCounts[anchorComponent]) {
        anchorComponent = id;
      }
    }
    const anchorCoverage = componentRoughCounts[anchorComponent]
      / componentFaceCounts[anchorComponent];
    if (
      componentRoughCounts[anchorComponent] > 0
      && anchorCoverage < FACE_SET_COMPLETION_BRIDGE_MAX_COVERAGE
    ) {
      bridgeComponent = anchorComponent;
    }
  }

  const fullShellComponents = new Set(
    paintedComponents.filter((id) => id !== bridgeComponent),
  );
  const fullShellMask = new Uint8Array(faceCount);
  let fullShellFaces = 0;
  for (let face = 0; face < faceCount; face += 1) {
    if (!fullShellComponents.has(componentId[face])) continue;
    fullShellMask[face] = 1;
    fullShellFaces += 1;
  }
  if (fullShellFaces > adaptiveFaceLimit) {
    return invalid(
      'unsafe_expansion',
      '粗涂命中了过多完整壳体，已保留原始粗涂；请只保留一组准备拆下的零件',
      {
        selectedShellCount: fullShellComponents.size,
        proposedFaces: fullShellFaces,
        safeFaceLimit: adaptiveFaceLimit,
      },
    );
  }

  const searchRoughMask = new Uint8Array(faceCount);
  let searchRoughFaces = 0;
  if (bridgeComponent >= 0) {
    for (let face = 0; face < faceCount; face += 1) {
      if (componentId[face] !== bridgeComponent || !roughMask[face]) continue;
      searchRoughMask[face] = 1;
      searchRoughFaces += 1;
    }
  }

  if (bridgeComponent < 0) {
    let addedFaces = 0;
    let removedFaces = 0;
    for (let face = 0; face < faceCount; face += 1) {
      if (fullShellMask[face] && !roughMask[face]) addedFaces += 1;
      else if (!fullShellMask[face] && roughMask[face]) removedFaces += 1;
    }
    return {
      status: 'ready',
      faceLabels: fullShellMask,
      loopPositions: new Float32Array(0),
      summary: {
        candidateCount: 0,
        branchPoints: 0,
        roughFaces,
        completedFaces: fullShellFaces,
        addedFaces,
        removedFaces,
        matchPercent: Math.round(
          ((roughFaces - removedFaces) / Math.max(roughFaces, 1)) * 100,
        ),
        seamEdges: 0,
        seamLengthLocal: 0,
        searchMode: 'rough_boundary',
        growthRings: 0,
        splitMode: 'shells',
        sourceShellCount: componentFaceCounts.length,
        selectedShellCount: fullShellComponents.size,
        fullShellFaces,
        bridgeShellFaces: 0,
      },
    };
  }
  if (!searchRoughFaces) {
    return invalid(
      'ambiguous_candidate',
      '粗涂没有命中可用于搜索接缝的桥接壳体；原始粗涂保持不变',
      { sourceShellCount: componentFaceCounts.length },
    );
  }

  // One conservative majority pass removes single-triangle holes and spikes
  // without materially shifting the user's intended joint boundary.
  const cleanedMask = searchRoughMask.slice();
  const nextMask = cleanedMask.slice();
  for (let face = 0; face < faceCount; face += 1) {
    let neighbors = 0;
    let selectedNeighbors = 0;
    for (let edge = 0; edge < 3; edge += 1) {
      const otherHalf = opposite[face * 3 + edge];
      if (otherHalf < 0) continue;
      neighbors += 1;
      selectedNeighbors += cleanedMask[Math.floor(otherHalf / 3)] ? 1 : 0;
    }
    if (neighbors < 3) continue;
    if (!cleanedMask[face] && selectedNeighbors >= 2) nextMask[face] = 1;
    else if (cleanedMask[face] && selectedNeighbors <= 1) nextMask[face] = 0;
  }

  const pointOfWelded = (welded: number): [number, number, number] => {
    const source = representativeSource[welded] * 3;
    return [positions[source], positions[source + 1], positions[source + 2]];
  };
  const hasWorldMatrix = Boolean(
    worldMatrix
    && worldMatrix.length >= 16
    && worldMatrix.slice(0, 16).every(Number.isFinite),
  );
  const transformPoint = (point: SeamPoint3): SeamPoint3 => {
    if (!hasWorldMatrix || !worldMatrix) return point;
    const x = point[0];
    const y = point[1];
    const z = point[2];
    const w = worldMatrix[3] * x + worldMatrix[7] * y + worldMatrix[11] * z + worldMatrix[15];
    const inverseW = Math.abs(w) > 1e-12 ? 1 / w : 1;
    return [
      (worldMatrix[0] * x + worldMatrix[4] * y + worldMatrix[8] * z + worldMatrix[12]) * inverseW,
      (worldMatrix[1] * x + worldMatrix[5] * y + worldMatrix[9] * z + worldMatrix[13]) * inverseW,
      (worldMatrix[2] * x + worldMatrix[6] * y + worldMatrix[10] * z + worldMatrix[14]) * inverseW,
    ];
  };
  const pointForProjection = (welded: number): SeamPoint3 => (
    transformPoint(pointOfWelded(welded))
  );
  const validAnchor = Boolean(
    seamAnchorLocal
    && seamAnchorLocal.length >= 3
    && seamAnchorLocal.slice(0, 3).every(Number.isFinite),
  );
  const anchorWorld = validAnchor && seamAnchorLocal
    ? transformPoint([
      Number(seamAnchorLocal[0]),
      Number(seamAnchorLocal[1]),
      Number(seamAnchorLocal[2]),
    ])
    : null;
  const localDiagonalVector: SeamPoint3 = [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ];
  const worldDiagonalVector: SeamPoint3 = hasWorldMatrix && worldMatrix
    ? [
      worldMatrix[0] * localDiagonalVector[0]
        + worldMatrix[4] * localDiagonalVector[1]
        + worldMatrix[8] * localDiagonalVector[2],
      worldMatrix[1] * localDiagonalVector[0]
        + worldMatrix[5] * localDiagonalVector[1]
        + worldMatrix[9] * localDiagonalVector[2],
      worldMatrix[2] * localDiagonalVector[0]
        + worldMatrix[6] * localDiagonalVector[1]
        + worldMatrix[10] * localDiagonalVector[2],
    ]
    : localDiagonalVector;
  const worldDiagonal = Math.max(
    Math.hypot(...worldDiagonalVector),
    1,
  );
  const loopLength = (vertices: number[]): number => {
    let total = 0;
    for (let index = 0; index < vertices.length; index += 1) {
      const a = pointOfWelded(vertices[index]);
      const b = pointOfWelded(vertices[(index + 1) % vertices.length]);
      total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }
    return total;
  };

  const visitation = new Uint32Array(faceCount);
  const queue = new Int32Array(faceCount);
  let generation = 0;
  const floodCandidate = (
    candidate: Pick<CandidateLoop, 'barrierHalves' | 'startFace'>,
    writeMask: Uint8Array | null,
  ): { componentFaces: number; roughInside: number } => {
    generation += 1;
    if (generation === 0xffffffff) {
      visitation.fill(0);
      generation = 1;
    }
    const barrier = new Set(candidate.barrierHalves);
    let head = 0;
    let tail = 1;
    queue[0] = candidate.startFace;
    visitation[candidate.startFace] = generation;
    let roughInside = 0;
    while (head < tail) {
      const face = queue[head++];
      roughInside += searchRoughMask[face] ? 1 : 0;
      if (writeMask) writeMask[face] = 1;
      for (let edge = 0; edge < 3; edge += 1) {
        const half = face * 3 + edge;
        if (barrier.has(half)) continue;
        const otherHalf = opposite[half];
        if (otherHalf < 0) continue;
        const neighbor = Math.floor(otherHalf / 3);
        if (visitation[neighbor] === generation) continue;
        visitation[neighbor] = generation;
        queue[tail++] = neighbor;
      }
    }
    return { componentFaces: tail, roughInside };
  };

  const candidates: CandidateLoop[] = [];
  let branchPoints = 0;
  let boundaryComponents = 0;

  const collectCandidates = (mask: Uint8Array, growthRings: number): void => {
    const boundaryEdges: BoundaryEdge[] = [];
    const boundaryByVertex = new Map<number, number[]>();
    for (let half = 0; half < opposite.length; half += 1) {
      const otherHalf = opposite[half];
      if (otherHalf < 0 || half > otherHalf) continue;
      const face = Math.floor(half / 3);
      const otherFace = Math.floor(otherHalf / 3);
      if (mask[face] === mask[otherFace]) continue;
      const edge = half % 3;
      const sourceA = originalIndex(face, edge);
      const sourceB = originalIndex(face, (edge + 1) % 3);
      const a = remap[sourceA];
      const b = remap[sourceB];
      const boundaryIndex = boundaryEdges.length;
      boundaryEdges.push({
        a,
        b,
        halfA: half,
        halfB: otherHalf,
        selectedHalf: mask[face] ? half : otherHalf,
      });
      for (const vertex of [a, b]) {
        const edges = boundaryByVertex.get(vertex);
        if (edges) edges.push(boundaryIndex);
        else boundaryByVertex.set(vertex, [boundaryIndex]);
      }
    }
    if (!boundaryEdges.length) return;

    const visitedEdges = new Uint8Array(boundaryEdges.length);
    const components: number[][] = [];
    for (let start = 0; start < boundaryEdges.length; start += 1) {
      if (visitedEdges[start]) continue;
      const component: number[] = [];
      const edgeQueue = [start];
      visitedEdges[start] = 1;
      for (let cursor = 0; cursor < edgeQueue.length; cursor += 1) {
        const edgeIndex = edgeQueue[cursor];
        component.push(edgeIndex);
        const edge = boundaryEdges[edgeIndex];
        for (const vertex of [edge.a, edge.b]) {
          for (const neighbor of boundaryByVertex.get(vertex) ?? []) {
            if (visitedEdges[neighbor]) continue;
            visitedEdges[neighbor] = 1;
            edgeQueue.push(neighbor);
          }
        }
      }
      components.push(component);
    }
    boundaryComponents += components.length;
    let currentBranchPoints = 0;
    for (const edges of boundaryByVertex.values()) {
      if (edges.length !== 2) currentBranchPoints += 1;
    }
    branchPoints = Math.max(branchPoints, currentBranchPoints);

    const orderedVertices = (component: number[]): number[] => {
      const allowed = new Set(component);
      const firstEdgeIndex = component[0];
      const firstEdge = boundaryEdges[firstEdgeIndex];
      const loop = [firstEdge.a];
      let current = firstEdge.b;
      let previous = firstEdgeIndex;
      const used = new Set<number>([firstEdgeIndex]);
      while (current !== loop[0]) {
        loop.push(current);
        const nextEdge = (boundaryByVertex.get(current) ?? [])
          .find((edgeIndex) => edgeIndex !== previous && allowed.has(edgeIndex));
        if (nextEdge === undefined || used.has(nextEdge)) return [];
        used.add(nextEdge);
        const edge = boundaryEdges[nextEdge];
        current = edge.a === current ? edge.b : edge.a;
        previous = nextEdge;
        if (used.size > component.length) return [];
      }
      return used.size === component.length ? loop : [];
    };

    const simpleComponents = components
      .filter((component) => component.length >= 3)
      .filter((component) => {
        const degrees = new Map<number, number>();
        for (const edgeIndex of component) {
          const edge = boundaryEdges[edgeIndex];
          degrees.set(edge.a, (degrees.get(edge.a) ?? 0) + 1);
          degrees.set(edge.b, (degrees.get(edge.b) ?? 0) + 1);
        }
        return [...degrees.values()].every((degree) => degree === 2);
      })
      .slice(0, FACE_SET_COMPLETION_CANDIDATE_LIMIT);

    for (const component of simpleComponents) {
      const vertexIds = orderedVertices(component);
      if (vertexIds.length < 3) continue;
      let anchorDistanceMm = 0;
      if (anchorWorld) {
        anchorDistanceMm = Infinity;
        for (const vertex of vertexIds) {
          const point = pointForProjection(vertex);
          anchorDistanceMm = Math.min(anchorDistanceMm, Math.hypot(
            point[0] - anchorWorld[0],
            point[1] - anchorWorld[1],
            point[2] - anchorWorld[2],
          ));
        }
      }
      const barrierHalves: number[] = [];
      for (const edgeIndex of component) {
        const edge = boundaryEdges[edgeIndex];
        barrierHalves.push(edge.halfA, edge.halfB);
      }
      const candidate: CandidateLoop = {
        barrierHalves,
        startFace: Math.floor(boundaryEdges[component[0]].selectedHalf / 3),
        vertexIds,
        seamLength: loopLength(vertexIds),
        componentFaces: 0,
        roughInside: 0,
        match: 0,
        score: 0,
        growthRings,
        projectionSafe: null,
        anchorDistanceMm,
      };
      const flooded = floodCandidate(candidate, null);
      candidate.componentFaces = flooded.componentFaces;
      candidate.roughInside = flooded.roughInside;
      const precision = candidate.roughInside / Math.max(candidate.componentFaces, 1);
      const recall = candidate.roughInside / searchRoughFaces;
      candidate.match = precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;
      candidate.score = candidate.match
        - Math.min(0.08, (candidate.seamLength / diagonal) * 0.015)
        - Math.min(0.06, growthRings * 0.00012)
        - (anchorWorld
          ? Math.min(1.5, (candidate.anchorDistanceMm / Math.max(worldDiagonal * 0.06, 1)) * 0.85)
          : 0);
      candidates.push(candidate);
    }
  };

  const isViable = (candidate: CandidateLoop) => (
    candidate.roughInside / searchRoughFaces >= FACE_SET_COMPLETION_MIN_ROUGH_RECALL
    && candidate.componentFaces + fullShellFaces <= adaptiveFaceLimit
    && (!anchorWorld || candidate.anchorDistanceMm <= Math.max(worldDiagonal * 0.18, 10))
  );
  const capSafeCandidates = (
    source: CandidateLoop[],
    limit = 3,
  ): CandidateLoop[] => {
    const ranked = [...source]
      .sort((a, b) => b.score - a.score || a.seamLength - b.seamLength)
      .slice(0, FACE_SET_COMPLETION_CAP_CANDIDATE_LIMIT);
    const safe: CandidateLoop[] = [];
    const seenLoops = new Set<string>();
    for (const candidate of ranked) {
      const loopSignature = [...candidate.vertexIds]
        .sort((a, b) => a - b)
        .join(',');
      if (seenLoops.has(loopSignature)) continue;
      seenLoops.add(loopSignature);
      if (candidate.projectionSafe === null) {
        candidate.projectionSafe = candidate.vertexIds.length
          <= FACE_SET_COMPLETION_CAP_CONTOUR_BUDGET
          && projectSeamLoop(
            candidate.vertexIds.map(pointForProjection),
          ).status === 'ready';
      }
      if (candidate.projectionSafe) {
        safe.push(candidate);
        if (safe.length >= limit) break;
      }
    }
    return safe;
  };

  collectCandidates(nextMask, 0);
  const initialViableCandidates = candidates.filter(isViable);
  const minimumHiddenEvidence = Math.max(8, Math.ceil(searchRoughFaces * 0.02));
  const initialWithHiddenCompletion = capSafeCandidates(
    initialViableCandidates.filter(
      (candidate) => candidate.componentFaces - candidate.roughInside >= minimumHiddenEvidence,
    ),
  );
  let growthViableCandidates: CandidateLoop[] = [];

  if (initialWithHiddenCompletion.length < 3) {
    const maxGrowthRings = FACE_SET_COMPLETION_GROWTH_STEPS[
      FACE_SET_COMPLETION_GROWTH_STEPS.length - 1
    ];
    const hasViewPosition = Boolean(
      viewPositionLocal
      && viewPositionLocal.length >= 3
      && viewPositionLocal.slice(0, 3).every(Number.isFinite),
    );
    const frontFacing = hasViewPosition ? new Uint8Array(faceCount) : null;
    if (frontFacing && viewPositionLocal) {
      const cameraX = Number(viewPositionLocal[0]);
      const cameraY = Number(viewPositionLocal[1]);
      const cameraZ = Number(viewPositionLocal[2]);
      for (let face = 0; face < faceCount; face += 1) {
        const ia = originalIndex(face, 0) * 3;
        const ib = originalIndex(face, 1) * 3;
        const ic = originalIndex(face, 2) * 3;
        const ax = positions[ia];
        const ay = positions[ia + 1];
        const az = positions[ia + 2];
        const abx = positions[ib] - ax;
        const aby = positions[ib + 1] - ay;
        const abz = positions[ib + 2] - az;
        const acx = positions[ic] - ax;
        const acy = positions[ic + 1] - ay;
        const acz = positions[ic + 2] - az;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        const centerX = (ax + positions[ib] + positions[ic]) / 3;
        const centerY = (ay + positions[ib + 1] + positions[ic + 1]) / 3;
        const centerZ = (az + positions[ib + 2] + positions[ic + 2]) / 3;
        const facing = nx * (cameraX - centerX)
          + ny * (cameraY - centerY)
          + nz * (cameraZ - centerZ);
        frontFacing[face] = facing > 0 ? 1 : 0;
      }
    }
    const distance = new Int32Array(faceCount);
    if (frontFacing) {
      const infinity = 0x3fffffff;
      const visibleFaceCost = 128;
      distance.fill(infinity);
      const buckets: number[][] = Array.from(
        { length: maxGrowthRings + 1 },
        () => [],
      );
      for (let face = 0; face < faceCount; face += 1) {
        if (!nextMask[face]) continue;
        distance[face] = 0;
        buckets[0].push(face);
      }
      for (let currentDistance = 0; currentDistance <= maxGrowthRings; currentDistance += 1) {
        const bucket = buckets[currentDistance];
        while (bucket.length) {
          const face = bucket.pop()!;
          if (distance[face] !== currentDistance) continue;
          for (let edge = 0; edge < 3; edge += 1) {
            const otherHalf = opposite[face * 3 + edge];
            if (otherHalf < 0) continue;
            const neighbor = Math.floor(otherHalf / 3);
            const cost = frontFacing[neighbor] ? visibleFaceCost : 1;
            const nextDistance = currentDistance + cost;
            if (nextDistance > maxGrowthRings || nextDistance >= distance[neighbor]) continue;
            distance[neighbor] = nextDistance;
            buckets[nextDistance].push(neighbor);
          }
        }
      }
    } else {
      distance.fill(-1);
      let head = 0;
      let tail = 0;
      for (let face = 0; face < faceCount; face += 1) {
        if (!nextMask[face]) continue;
        distance[face] = 0;
        queue[tail++] = face;
      }
      while (head < tail) {
        const face = queue[head++];
        const nextDistance = distance[face] + 1;
        if (nextDistance > maxGrowthRings) continue;
        for (let edge = 0; edge < 3; edge += 1) {
          const otherHalf = opposite[face * 3 + edge];
          if (otherHalf < 0) continue;
          const neighbor = Math.floor(otherHalf / 3);
          if (distance[neighbor] >= 0) continue;
          distance[neighbor] = nextDistance;
          queue[tail++] = neighbor;
        }
      }
    }

    const grownMask = new Uint8Array(faceCount);
    for (const growthRings of FACE_SET_COMPLETION_GROWTH_STEPS) {
      let grownFaces = 0;
      for (let face = 0; face < faceCount; face += 1) {
        const selected = distance[face] >= 0 && distance[face] <= growthRings;
        grownMask[face] = selected ? 1 : 0;
        grownFaces += selected ? 1 : 0;
      }
      if (grownFaces > adaptiveFaceLimit * 1.25) break;
      collectCandidates(grownMask, growthRings);
      growthViableCandidates = capSafeCandidates(
        candidates.filter(
          (candidate) => candidate.growthRings > 0 && isViable(candidate),
        ),
      );
      if (growthViableCandidates.length >= 3) break;
    }
  }

  const hiddenCompletedCandidates = candidates.filter((candidate) => (
    isViable(candidate)
    && (
      candidate.growthRings > 0
      || candidate.componentFaces - candidate.roughInside >= minimumHiddenEvidence
    )
  ));
  const viableCandidates = capSafeCandidates(
    hiddenCompletedCandidates.length
      ? hiddenCompletedCandidates
      : initialViableCandidates,
  );
  viableCandidates.sort((a, b) => b.score - a.score || a.seamLength - b.seamLength);
  candidates.sort((a, b) => b.score - a.score || a.seamLength - b.seamLength);
  const winner = viableCandidates[0];
  if (!winner) {
    const projectionRejected = candidates.some(
      (candidate) => isViable(candidate) && candidate.projectionSafe === false,
    );
    if (projectionRejected) {
      return invalid(
        'no_closed_candidate',
        '自动候选接缝在封口投影中发生交叉，已继续搜索其他关节环但仍无安全结果；请把粗涂收窄到关节根部后重试',
        {
          candidateCount: candidates.length,
          projectionCandidatesChecked: candidates.filter(
            (candidate) => candidate.projectionSafe !== null,
          ).length,
        },
      );
    }
    const bestCandidate = candidates[0];
    if (bestCandidate) {
      return invalid(
        'unsafe_expansion',
        '自动补全会扩张到过大的模型区域，已保留原始粗涂；请只粗涂一个关节附近的连续零件',
        {
          candidateCount: candidates.length,
          roughFaces,
          proposedFaces: bestCandidate.componentFaces + fullShellFaces,
          safeFaceLimit: adaptiveFaceLimit,
          searchedGrowthRings: FACE_SET_COMPLETION_GROWTH_STEPS[
            FACE_SET_COMPLETION_GROWTH_STEPS.length - 1
          ],
        },
      );
    }
    return invalid(
      'no_closed_candidate',
      '已沿网格扩张到背面，但仍未找到可靠的关节闭环；原始粗涂保持不变',
      {
        candidateCount: candidates.length,
        branchPoints,
        boundaryComponents,
        searchedGrowthRings: FACE_SET_COMPLETION_GROWTH_STEPS[
          FACE_SET_COMPLETION_GROWTH_STEPS.length - 1
        ],
      },
    );
  }

  const materializeCandidate = (candidate: CandidateLoop): FaceSetCompletionOption | null => {
    const completed = new Uint8Array(faceCount);
    floodCandidate(candidate, completed);
    for (let face = 0; face < faceCount; face += 1) {
      if (fullShellMask[face]) completed[face] = 1;
    }
    let completedFaces = 0;
    let addedFaces = 0;
    let removedFaces = 0;
    for (let face = 0; face < faceCount; face += 1) {
      completedFaces += completed[face] ? 1 : 0;
      if (completed[face] && !roughMask[face]) addedFaces += 1;
      else if (!completed[face] && roughMask[face]) removedFaces += 1;
    }
    if (!completedFaces || completedFaces === faceCount) return null;
    const loopPositions = new Float32Array(candidate.vertexIds.length * 3);
    candidate.vertexIds.forEach((vertex, index) => {
      loopPositions.set(pointOfWelded(vertex), index * 3);
    });
    return {
      faceLabels: completed,
      loopPositions,
      summary: {
        candidateCount: candidates.length,
        branchPoints,
        roughFaces,
        completedFaces,
        addedFaces,
        removedFaces,
        matchPercent: Math.round(candidate.match * 100),
        seamEdges: candidate.barrierHalves.length / 2,
        seamLengthLocal: candidate.seamLength,
        searchMode: candidate.growthRings > 0 ? 'seed_growth' : 'rough_boundary',
        growthRings: candidate.growthRings,
        splitMode: fullShellComponents.size > 0 ? 'hybrid' : 'surface',
        sourceShellCount: componentFaceCounts.length,
        selectedShellCount: fullShellComponents.size,
        fullShellFaces,
        bridgeShellFaces: candidate.componentFaces,
        anchorDistanceMm: anchorWorld ? candidate.anchorDistanceMm : undefined,
      },
    };
  };
  const options = viableCandidates
    .map(materializeCandidate)
    .filter((option): option is FaceSetCompletionOption => option !== null);
  if (!options.length) {
    return invalid('ambiguous_candidate', '推荐闭环没有把模型稳定分成两个区域');
  }
  options.forEach((option, index) => {
    option.summary.optionIndex = index;
    option.summary.optionCount = options.length;
  });
  const [primary, ...alternatives] = options;
  return {
    status: 'ready',
    faceLabels: primary.faceLabels,
    loopPositions: primary.loopPositions,
    summary: primary.summary,
    alternatives,
  };
}
