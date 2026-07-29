import * as THREE from 'three';

export type FacePaintMode = 'add' | 'erase';

export interface FacePaintChange {
  faceIndex: number;
  previous: 0 | 1;
}

export interface FacePaintEdge {
  a: number;
  b: number;
  idA: number;
  idB: number;
  faces: number[];
}

export interface FacePaintTopology {
  geometry: THREE.BufferGeometry;
  faceCount: number;
  vertexPositions: Float32Array;
  edges: FacePaintEdge[];
}

export type FacePaintBoundaryResult =
  | { status: 'ready'; positions: Float32Array; segmentCount: number }
  | { status: 'budget'; positions: Float32Array; segmentCount: 0 };

export const FACE_PAINT_BOUNDARY_FACE_BUDGET = 100_000;

export function faceCountOfGeometry(geometry: THREE.BufferGeometry): number {
  const count = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
  return Math.floor(count / 3);
}

/**
 * Apply one brush sample without allocating a new mask. The caller owns stroke
 * coalescing: a face records its pre-stroke value only once.
 */
export function applyFacePaintSample(
  mask: Uint8Array,
  faceIndices: Iterable<number>,
  mode: FacePaintMode,
  strokeChanges: Map<number, 0 | 1>,
): number[] {
  const nextValue: 0 | 1 = mode === 'add' ? 1 : 0;
  const changed: number[] = [];
  for (const faceIndex of faceIndices) {
    if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= mask.length) continue;
    const previous = mask[faceIndex] as 0 | 1;
    if (previous === nextValue) continue;
    if (!strokeChanges.has(faceIndex)) strokeChanges.set(faceIndex, previous);
    mask[faceIndex] = nextValue;
    changed.push(faceIndex);
  }
  return changed;
}

export function paintedFaceCount(mask: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) count += mask[index] ? 1 : 0;
  return count;
}

function positionIndexAt(
  geometry: THREE.BufferGeometry,
  cornerIndex: number,
): number {
  return geometry.index ? geometry.index.getX(cornerIndex) : cornerIndex;
}

function candidateVertexKey(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  positionIndex: number,
): string {
  const scale = 100_000;
  return `${Math.round(position.getX(positionIndex) * scale)},${Math.round(position.getY(positionIndex) * scale)},${Math.round(position.getZ(positionIndex) * scale)}`;
}

/**
 * A spherical BVH query can also touch the back side of a thin model. Keep only
 * the edge-connected patch reachable from the actually hit triangle, and reject
 * faces whose normals point away from that hit surface.
 */
export function connectedSurfaceCandidates(
  geometry: THREE.BufferGeometry,
  candidateFaces: Iterable<number>,
  seedFaceIndex: number,
  seedNormal?: THREE.Vector3,
  minNormalDot = 0.05,
): number[] {
  const position = geometry.getAttribute('position');
  const faceCount = faceCountOfGeometry(geometry);
  if (!position || seedFaceIndex < 0 || seedFaceIndex >= faceCount) return [];
  const candidates = new Set<number>();
  for (const faceIndex of candidateFaces) {
    if (Number.isInteger(faceIndex) && faceIndex >= 0 && faceIndex < faceCount) candidates.add(faceIndex);
  }
  candidates.add(seedFaceIndex);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const referenceNormal = seedNormal?.clone().normalize() ?? (() => {
    const base = seedFaceIndex * 3;
    a.fromBufferAttribute(position, positionIndexAt(geometry, base));
    b.fromBufferAttribute(position, positionIndexAt(geometry, base + 1));
    c.fromBufferAttribute(position, positionIndexAt(geometry, base + 2));
    return normal.copy(b).sub(a).cross(c.clone().sub(a)).normalize().clone();
  })();

  const edgeFaces = new Map<string, number[]>();
  const faceEdges = new Map<number, string[]>();
  for (const faceIndex of candidates) {
    const base = faceIndex * 3;
    const corners = [
      positionIndexAt(geometry, base),
      positionIndexAt(geometry, base + 1),
      positionIndexAt(geometry, base + 2),
    ];
    a.fromBufferAttribute(position, corners[0]);
    b.fromBufferAttribute(position, corners[1]);
    c.fromBufferAttribute(position, corners[2]);
    normal.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
    if (faceIndex !== seedFaceIndex && normal.dot(referenceNormal) < minNormalDot) continue;
    const vertexKeys = corners.map((positionIndex) => candidateVertexKey(position, positionIndex));
    const edges: string[] = [];
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
      const keyA = vertexKeys[edgeIndex];
      const keyB = vertexKeys[(edgeIndex + 1) % 3];
      const edgeKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
      edges.push(edgeKey);
      const faces = edgeFaces.get(edgeKey);
      if (faces) faces.push(faceIndex);
      else edgeFaces.set(edgeKey, [faceIndex]);
    }
    faceEdges.set(faceIndex, edges);
  }

  if (!faceEdges.has(seedFaceIndex)) return [seedFaceIndex];
  const connected: number[] = [];
  const visited = new Set<number>([seedFaceIndex]);
  const queue = [seedFaceIndex];
  while (queue.length) {
    const faceIndex = queue.shift()!;
    connected.push(faceIndex);
    for (const edgeKey of faceEdges.get(faceIndex) ?? []) {
      for (const neighbor of edgeFaces.get(edgeKey) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return connected;
}

function weldVertexIds(geometry: THREE.BufferGeometry): {
  ids: Int32Array;
  positions: Float32Array;
} {
  const position = geometry.getAttribute('position');
  const ids = new Int32Array(position.count);
  geometry.computeBoundingBox();
  const diagonal = geometry.boundingBox?.getSize(new THREE.Vector3()).length() ?? 1;
  const epsilon = Math.max(diagonal * 1e-6, 1e-7);
  const inverse = 1 / epsilon;
  const keyToId = new Map<string, number>();
  const values: number[] = [];
  let nextId = 0;
  for (let index = 0; index < position.count; index += 1) {
    const key = `${Math.round(position.getX(index) * inverse)},${Math.round(position.getY(index) * inverse)},${Math.round(position.getZ(index) * inverse)}`;
    let id = keyToId.get(key);
    if (id === undefined) {
      id = nextId++;
      keyToId.set(key, id);
      values.push(position.getX(index), position.getY(index), position.getZ(index));
    }
    ids[index] = id;
  }
  return { ids, positions: new Float32Array(values) };
}

/**
 * Builds welded edge adjacency once, after the first completed stroke. Large
 * assets skip this CPU-heavy helper; their painted patch remains visible and
 * the UI reports that an explicit line boundary is unavailable.
 */
export function buildFacePaintTopology(
  geometry: THREE.BufferGeometry,
  faceBudget = FACE_PAINT_BOUNDARY_FACE_BUDGET,
): FacePaintTopology | null {
  const faceCount = faceCountOfGeometry(geometry);
  const position = geometry.getAttribute('position');
  if (!position || faceCount === 0 || faceCount > faceBudget) return null;
  const welded = weldVertexIds(geometry);
  const vertexIds = welded.ids;
  const edges = new Map<string, FacePaintEdge>();
  for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
    const corners = [
      positionIndexAt(geometry, faceIndex * 3),
      positionIndexAt(geometry, faceIndex * 3 + 1),
      positionIndexAt(geometry, faceIndex * 3 + 2),
    ];
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
      const a = corners[edgeIndex];
      const b = corners[(edgeIndex + 1) % 3];
      const idA = vertexIds[a];
      const idB = vertexIds[b];
      const key = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
      const edge = edges.get(key);
      if (edge) {
        edge.faces.push(faceIndex);
      } else {
        edges.set(key, { a, b, idA, idB, faces: [faceIndex] });
      }
    }
  }
  return {
    geometry,
    faceCount,
    vertexPositions: welded.positions,
    edges: [...edges.values()],
  };
}

export function boundarySegmentsFromTopology(
  topology: FacePaintTopology | null,
  mask: Uint8Array,
): FacePaintBoundaryResult {
  if (!topology) {
    return { status: 'budget', positions: new Float32Array(0), segmentCount: 0 };
  }
  const position = topology.geometry.getAttribute('position');
  const values: number[] = [];
  for (const edge of topology.edges) {
    let painted = 0;
    for (const faceIndex of edge.faces) painted += mask[faceIndex] ? 1 : 0;
    const isClosedBoundary = painted > 0 && painted < edge.faces.length;
    const isOpenPaintedBoundary = edge.faces.length === 1 && painted === 1;
    if (!isClosedBoundary && !isOpenPaintedBoundary) continue;
    values.push(
      position.getX(edge.a),
      position.getY(edge.a),
      position.getZ(edge.a),
      position.getX(edge.b),
      position.getY(edge.b),
      position.getZ(edge.b),
    );
  }
  return {
    status: 'ready',
    positions: new Float32Array(values),
    segmentCount: values.length / 6,
  };
}
