import { ShapeUtils, Vector2 } from 'three';

export type SplitVec3 = [number, number, number];

export interface PlaneEquation {
  normal: SplitVec3;
  constant: number;
}

export interface PlaneSplitInput {
  positions: ArrayLike<number>;
  index?: ArrayLike<number> | null;
  plane: PlaneEquation;
  epsilon?: number;
  maxSourceFaces?: number;
}

export interface PlaneSplitPart {
  positions: Float32Array;
  sourceFaceCount: number;
  capFaceCount: number;
  faceCount: number;
  vertexCount: number;
  bounds: {
    min: SplitVec3;
    max: SplitVec3;
    dimensions: SplitVec3;
  };
}

export type PlaneSplitFailureCode =
  | 'invalid_geometry'
  | 'invalid_plane'
  | 'too_complex'
  | 'no_intersection'
  | 'coplanar_ambiguity'
  | 'open_section'
  | 'cap_failed'
  | 'empty_part';

export type PlaneSplitResult =
  | {
      status: 'ready';
      partA: PlaneSplitPart;
      partB: PlaneSplitPart;
      loopCount: number;
      cutSegmentCount: number;
      epsilon: number;
    }
  | {
      status: 'blocked';
      code: PlaneSplitFailureCode;
      message: string;
    };

interface CutVertex {
  point: SplitVec3;
  distance: number;
}

interface SectionVertex {
  point: SplitVec3;
  uv: Vector2;
}

interface ProjectedLoop {
  vertices: SectionVertex[];
  depth: number;
}

const DEFAULT_MAX_SOURCE_FACES = 2_000_000;

function add(a: SplitVec3, b: SplitVec3): SplitVec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: SplitVec3, b: SplitVec3): SplitVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function mul(a: SplitVec3, scalar: number): SplitVec3 {
  return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

function dot(a: SplitVec3, b: SplitVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: SplitVec3, b: SplitVec3): SplitVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length(a: SplitVec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize(a: SplitVec3): SplitVec3 | null {
  const len = length(a);
  return Number.isFinite(len) && len > 1e-12 ? mul(a, 1 / len) : null;
}

function lerp(a: SplitVec3, b: SplitVec3, t: number): SplitVec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function distanceSq(a: SplitVec3, b: SplitVec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function triangleArea2(a: SplitVec3, b: SplitVec3, c: SplitVec3): number {
  return length(cross(sub(b, a), sub(c, a)));
}

function pushTriangle(target: number[], a: SplitVec3, b: SplitVec3, c: SplitVec3, minArea2: number): boolean {
  if (triangleArea2(a, b, c) <= minArea2) return false;
  target.push(...a, ...b, ...c);
  return true;
}

function uniquePoints(points: SplitVec3[], epsilon: number): SplitVec3[] {
  const epsilonSq = epsilon * epsilon;
  const unique: SplitVec3[] = [];
  for (const point of points) {
    if (!unique.some((candidate) => distanceSq(candidate, point) <= epsilonSq)) unique.push(point);
  }
  return unique;
}

function clipTriangle(vertices: CutVertex[], keepPositive: boolean, epsilon: number): SplitVec3[] {
  const output: CutVertex[] = [];
  const inside = (distance: number) => keepPositive ? distance >= -epsilon : distance <= epsilon;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    const currentInside = inside(current.distance);
    const nextInside = inside(next.distance);
    if (currentInside && nextInside) {
      output.push(next);
    } else if (currentInside !== nextInside) {
      const denominator = current.distance - next.distance;
      if (Math.abs(denominator) > 1e-18) {
        const t = current.distance / denominator;
        output.push({ point: lerp(current.point, next.point, t), distance: 0 });
      }
      if (nextInside) output.push(next);
    }
  }
  const points = uniquePoints(output.map((vertex) => vertex.point), epsilon * 0.5);
  if (points.length > 2 && distanceSq(points[0], points[points.length - 1]) <= epsilon * epsilon) points.pop();
  return points;
}

function appendPolygon(target: number[], polygon: SplitVec3[], minArea2: number): number {
  let count = 0;
  for (let index = 1; index + 1 < polygon.length; index += 1) {
    if (pushTriangle(target, polygon[0], polygon[index], polygon[index + 1], minArea2)) count += 1;
  }
  return count;
}

function pointAt(
  positions: ArrayLike<number>,
  sourceIndex: ArrayLike<number> | null | undefined,
  triangleOffset: number,
  corner: number,
): SplitVec3 | null {
  const vertexIndex = sourceIndex
    ? Number(sourceIndex[triangleOffset * 3 + corner])
    : triangleOffset * 3 + corner;
  const offset = vertexIndex * 3;
  if (
    !Number.isInteger(vertexIndex)
    || vertexIndex < 0
    || offset + 2 >= positions.length
  ) return null;
  const point: SplitVec3 = [
    Number(positions[offset]),
    Number(positions[offset + 1]),
    Number(positions[offset + 2]),
  ];
  return point.every(Number.isFinite) ? point : null;
}

function boundsOfPositions(positions: ArrayLike<number>): { min: SplitVec3; max: SplitVec3; diagonal: number } | null {
  if (positions.length < 9 || positions.length % 3 !== 0) return null;
  const min: SplitVec3 = [Infinity, Infinity, Infinity];
  const max: SplitVec3 = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = Number(positions[offset + axis]);
      if (!Number.isFinite(value)) return null;
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max, diagonal: length(sub(max, min)) };
}

function segmentKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function weldSectionSegments(
  segments: [SplitVec3, SplitVec3][],
  tolerance: number,
): { points: SplitVec3[]; edges: [number, number][] } {
  const points: SplitVec3[] = [];
  const buckets = new Map<string, number[]>();
  const toleranceSq = tolerance * tolerance;
  const cellOf = (point: SplitVec3): [number, number, number] => [
    Math.floor(point[0] / tolerance),
    Math.floor(point[1] / tolerance),
    Math.floor(point[2] / tolerance),
  ];
  const keyOfCell = (cell: [number, number, number]) => `${cell[0]},${cell[1]},${cell[2]}`;
  const indexOf = (point: SplitVec3): number => {
    const cell = cellOf(point);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = buckets.get(keyOfCell([cell[0] + dx, cell[1] + dy, cell[2] + dz]));
          if (!bucket) continue;
          const existing = bucket.find((index) => distanceSq(points[index], point) <= toleranceSq);
          if (existing !== undefined) return existing;
        }
      }
    }
    const index = points.length;
    points.push(point);
    const key = keyOfCell(cell);
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
    return index;
  };

  const edgeSet = new Set<string>();
  const edges: [number, number][] = [];
  for (const [start, end] of segments) {
    const a = indexOf(start);
    const b = indexOf(end);
    if (a === b) continue;
    const key = segmentKey(a, b);
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    edges.push([a, b]);
  }
  return { points, edges };
}

function buildLoops(points: SplitVec3[], edges: [number, number][]): number[][] | null {
  const adjacency = new Map<number, number[]>();
  for (const [a, b] of edges) {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  for (const neighbors of adjacency.values()) {
    if (new Set(neighbors).size !== 2) return null;
  }

  const visited = new Set<string>();
  const loops: number[][] = [];
  for (const [edgeA, edgeB] of edges) {
    if (visited.has(segmentKey(edgeA, edgeB))) continue;
    const loop: number[] = [];
    const start = edgeA;
    let previous = -1;
    let current = start;
    for (let guard = 0; guard <= edges.length + 1; guard += 1) {
      loop.push(current);
      const neighbors = adjacency.get(current);
      if (!neighbors || neighbors.length !== 2) return null;
      const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
      visited.add(segmentKey(current, next));
      previous = current;
      current = next;
      if (current === start) break;
      if (loop.includes(current)) return null;
    }
    if (current !== start || loop.length < 3) return null;
    loops.push(loop);
  }
  if (visited.size !== edges.length) return null;
  return loops;
}

function planeBasis(normal: SplitVec3): { u: SplitVec3; v: SplitVec3 } {
  const reference: SplitVec3 = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = normalize(cross(reference, normal)) ?? [1, 0, 0];
  const v = normalize(cross(normal, u)) ?? [0, 1, 0];
  return { u, v };
}

function pointInPolygon(point: Vector2, polygon: Vector2[]): boolean {
  let inside = false;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a, a += 1) {
    const pa = polygon[a];
    const pb = polygon[b];
    const intersects = ((pa.y > point.y) !== (pb.y > point.y))
      && point.x < ((pb.x - pa.x) * (point.y - pa.y)) / (pb.y - pa.y) + pa.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function simplifySectionLoop(vertices: SectionVertex[]): SectionVertex[] {
  if (vertices.length <= 3) return vertices;
  let current = [...vertices];
  let changed = true;
  while (changed && current.length > 3) {
    changed = false;
    const next: SectionVertex[] = [];
    for (let index = 0; index < current.length; index += 1) {
      const previous = current[(index + current.length - 1) % current.length].uv;
      const point = current[index].uv;
      const following = current[(index + 1) % current.length].uv;
      const ax = point.x - previous.x;
      const ay = point.y - previous.y;
      const bx = following.x - point.x;
      const by = following.y - point.y;
      const area2 = Math.abs(ax * by - ay * bx);
      const scale = Math.max(1, Math.hypot(ax, ay) * Math.hypot(bx, by));
      if (area2 <= scale * 1e-9) {
        changed = true;
        continue;
      }
      next.push(current[index]);
    }
    if (next.length < 3) return current;
    current = next;
  }
  return current;
}

function projectedLoops(
  loops: number[][],
  points: SplitVec3[],
  normal: SplitVec3,
): ProjectedLoop[] {
  const { u, v } = planeBasis(normal);
  const projected = loops.map((loop) => ({
    vertices: simplifySectionLoop(loop.map((index) => ({
      point: points[index],
      uv: new Vector2(dot(points[index], u), dot(points[index], v)),
    }))),
    depth: 0,
  }));
  for (let index = 0; index < projected.length; index += 1) {
    const sample = projected[index].vertices[0].uv;
    projected[index].depth = projected.reduce((depth, candidate, candidateIndex) => (
      candidateIndex !== index && pointInPolygon(sample, candidate.vertices.map((vertex) => vertex.uv))
        ? depth + 1
        : depth
    ), 0);
  }
  return projected;
}

function capTriangles(projected: ProjectedLoop[]): SplitVec3[][] | null {
  const triangles: SplitVec3[][] = [];
  for (let outerIndex = 0; outerIndex < projected.length; outerIndex += 1) {
    const outer = projected[outerIndex];
    if (outer.depth % 2 !== 0) continue;
    const holes = projected.filter((candidate, candidateIndex) => (
      candidateIndex !== outerIndex
      && candidate.depth === outer.depth + 1
      && pointInPolygon(candidate.vertices[0].uv, outer.vertices.map((vertex) => vertex.uv))
    ));
    const contour2d = outer.vertices.map((vertex) => vertex.uv);
    const holes2d = holes.map((hole) => hole.vertices.map((vertex) => vertex.uv));
    const flat3d = [
      ...outer.vertices.map((vertex) => vertex.point),
      ...holes.flatMap((hole) => hole.vertices.map((vertex) => vertex.point)),
    ];
    let indices: number[][];
    try {
      indices = ShapeUtils.triangulateShape(contour2d, holes2d);
    } catch {
      return null;
    }
    if (!indices.length) return null;
    for (const triangle of indices) {
      const points = triangle.map((index) => flat3d[index]);
      if (points.length !== 3 || points.some((point) => !point)) return null;
      triangles.push(points as SplitVec3[]);
    }
  }
  return triangles.length ? triangles : null;
}

function orientTriangle(triangle: SplitVec3[], desiredNormal: SplitVec3): [SplitVec3, SplitVec3, SplitVec3] {
  const [a, b, c] = triangle;
  return dot(cross(sub(b, a), sub(c, a)), desiredNormal) >= 0 ? [a, b, c] : [a, c, b];
}

function partStats(positions: number[], sourceFaceCount: number, capFaceCount: number, epsilon: number): PlaneSplitPart {
  const array = Float32Array.from(positions);
  const bounds = boundsOfPositions(array)!;
  const unique = new Set<string>();
  const quantize = (value: number) => Math.round(value / epsilon);
  for (let offset = 0; offset < array.length; offset += 3) {
    unique.add(`${quantize(array[offset])},${quantize(array[offset + 1])},${quantize(array[offset + 2])}`);
  }
  return {
    positions: array,
    sourceFaceCount,
    capFaceCount,
    faceCount: array.length / 9,
    vertexCount: unique.size,
    bounds: {
      min: bounds.min,
      max: bounds.max,
      dimensions: sub(bounds.max, bounds.min),
    },
  };
}

function blocked(code: PlaneSplitFailureCode, message: string): PlaneSplitResult {
  return { status: 'blocked', code, message };
}

/**
 * 用一张无限平面把三角网格裁成两侧，并以截面轮廓封口。
 *
 * 输出仍处于源资产局部坐标系；调用方可让两个派生实例复用源实例的 TRS。
 * 为避免悄悄生成错误拓扑，平面与整条网格边重合、截面不闭合或封口失败时会安全阻断。
 */
export function splitMeshByPlane(input: PlaneSplitInput): PlaneSplitResult {
  const sourceBounds = boundsOfPositions(input.positions);
  if (!sourceBounds) return blocked('invalid_geometry', '源网格顶点数据无效');
  const indexLength = input.index?.length ?? input.positions.length / 3;
  if (!Number.isInteger(indexLength) || indexLength < 3 || indexLength % 3 !== 0) {
    return blocked('invalid_geometry', '源网格三角面索引无效');
  }
  const sourceFaceCount = indexLength / 3;
  if (sourceFaceCount > (input.maxSourceFaces ?? DEFAULT_MAX_SOURCE_FACES)) {
    return blocked('too_complex', `源网格包含 ${sourceFaceCount.toLocaleString()} 个三角面，超过本次切割上限`);
  }

  const normal = normalize(input.plane.normal);
  if (!normal || !Number.isFinite(input.plane.constant)) {
    return blocked('invalid_plane', '切割平面参数无效');
  }
  const scale = Math.max(sourceBounds.diagonal, 1);
  const epsilon = Math.max(input.epsilon ?? scale * 1e-7, 1e-8);
  const minArea2 = epsilon * epsilon;
  const sideA: number[] = [];
  const sideB: number[] = [];
  const segments: [SplitVec3, SplitVec3][] = [];
  const coplanarEdges = new Map<string, {
    segment: [SplitVec3, SplitVec3];
    sides: Set<-1 | 1>;
  }>();
  const pointKey = (point: SplitVec3) => point.map((value) => Math.round(value / (epsilon * 4))).join(',');
  const coplanarKey = (a: SplitVec3, b: SplitVec3) => {
    const keyA = pointKey(a);
    const keyB = pointKey(b);
    return keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
  };
  let sourceFacesA = 0;
  let sourceFacesB = 0;

  for (let triangleIndex = 0; triangleIndex < sourceFaceCount; triangleIndex += 1) {
    const points = [0, 1, 2].map((corner) => pointAt(
      input.positions,
      input.index,
      triangleIndex,
      corner,
    ));
    if (points.some((point) => !point)) return blocked('invalid_geometry', '源网格包含越界索引或非法顶点');
    const triangle = points as SplitVec3[];
    const vertices: CutVertex[] = triangle.map((point) => ({
      point,
      distance: dot(normal, point) + input.plane.constant,
    }));
    const positiveCount = vertices.filter((vertex) => vertex.distance > epsilon).length;
    const negativeCount = vertices.filter((vertex) => vertex.distance < -epsilon).length;
    const onPlaneCount = 3 - positiveCount - negativeCount;

    if (onPlaneCount === 3) {
      return blocked(
        'coplanar_ambiguity',
        '切割平面与网格表面重合，请将切割框轻微移动后重试',
      );
    }
    if (onPlaneCount === 2) {
      const edge = vertices.filter((vertex) => Math.abs(vertex.distance) <= epsilon).map((vertex) => vertex.point);
      const side: -1 | 1 = positiveCount ? 1 : -1;
      const key = coplanarKey(edge[0], edge[1]);
      const record = coplanarEdges.get(key) ?? {
        segment: [edge[0], edge[1]] as [SplitVec3, SplitVec3],
        sides: new Set<-1 | 1>(),
      };
      record.sides.add(side);
      coplanarEdges.set(key, record);
      if (side > 0) {
        if (pushTriangle(sideA, triangle[0], triangle[1], triangle[2], minArea2)) sourceFacesA += 1;
      } else if (pushTriangle(sideB, triangle[0], triangle[1], triangle[2], minArea2)) {
        sourceFacesB += 1;
      }
      continue;
    }
    if (!positiveCount && !negativeCount) {
      return blocked('coplanar_ambiguity', '切割平面与网格表面重合，请调整位置');
    }
    if (!negativeCount) {
      if (pushTriangle(sideA, triangle[0], triangle[1], triangle[2], minArea2)) sourceFacesA += 1;
      continue;
    }
    if (!positiveCount) {
      if (pushTriangle(sideB, triangle[0], triangle[1], triangle[2], minArea2)) sourceFacesB += 1;
      continue;
    }

    const clippedA = clipTriangle(vertices, true, epsilon);
    const clippedB = clipTriangle(vertices, false, epsilon);
    sourceFacesA += appendPolygon(sideA, clippedA, minArea2);
    sourceFacesB += appendPolygon(sideB, clippedB, minArea2);

    const intersections: SplitVec3[] = [];
    for (let edge = 0; edge < 3; edge += 1) {
      const current = vertices[edge];
      const next = vertices[(edge + 1) % 3];
      if (Math.abs(current.distance) <= epsilon) intersections.push(current.point);
      if (
        (current.distance > epsilon && next.distance < -epsilon)
        || (current.distance < -epsilon && next.distance > epsilon)
      ) {
        intersections.push(lerp(
          current.point,
          next.point,
          current.distance / (current.distance - next.distance),
        ));
      }
    }
    const unique = uniquePoints(intersections, epsilon);
    if (unique.length !== 2) {
      return blocked('open_section', '截面在局部产生了不确定分叉，请轻微调整切割位置或角度');
    }
    segments.push([unique[0], unique[1]]);
  }

  // 平面恰好沿现有网格边通过时，仅把“两侧各有一个相邻面”的边纳入截面。
  // 两个相邻面都在同侧说明只是相切，不应伪造封口边。
  for (const record of coplanarEdges.values()) {
    if (record.sides.size === 2) segments.push(record.segment);
  }

  if (!segments.length || !sourceFacesA || !sourceFacesB) {
    return blocked('no_intersection', '切割平面没有穿过模型实体，请把切割框移动到模型内部');
  }

  const welded = weldSectionSegments(segments, epsilon * 4);
  const loops = buildLoops(welded.points, welded.edges);
  if (!loops?.length) {
    return blocked('open_section', '切割截面未形成闭合轮廓；源模型可能存在开口或非流形结构');
  }
  const cap = capTriangles(projectedLoops(loops, welded.points, normal));
  if (!cap?.length) return blocked('cap_failed', '截面封口三角化失败，请调整切割位置或角度');

  let capFacesA = 0;
  let capFacesB = 0;
  for (const triangle of cap) {
    const a = orientTriangle(triangle, mul(normal, -1));
    const b = orientTriangle(triangle, normal);
    if (pushTriangle(sideA, a[0], a[1], a[2], minArea2)) capFacesA += 1;
    if (pushTriangle(sideB, b[0], b[1], b[2], minArea2)) capFacesB += 1;
  }
  if (!capFacesA || !capFacesB) return blocked('cap_failed', '截面封口没有生成有效三角面');
  if (sideA.length < 9 || sideB.length < 9) return blocked('empty_part', '切割后有一侧没有形成有效模型');

  return {
    status: 'ready',
    partA: partStats(sideA, sourceFacesA, capFacesA, epsilon * 4),
    partB: partStats(sideB, sourceFacesB, capFacesB, epsilon * 4),
    loopCount: loops.length,
    cutSegmentCount: welded.edges.length,
    epsilon,
  };
}
