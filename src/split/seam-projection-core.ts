export type SeamPoint3 = readonly [number, number, number];
export type SeamPoint2 = [number, number];

export interface SeamProjection {
  status: 'ready' | 'degenerate' | 'self_intersection';
  center: [number, number, number];
  normal: [number, number, number];
  contour: SeamPoint2[];
  signedArea2: number;
  diagonal: number;
  maxDeviation: number;
  warpRatio: number;
}

function orient(a: SeamPoint2, b: SeamPoint2, c: SeamPoint2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(
  a: SeamPoint2,
  b: SeamPoint2,
  point: SeamPoint2,
  epsilon: number,
): boolean {
  return Math.abs(orient(a, b, point)) <= epsilon
    && point[0] >= Math.min(a[0], b[0]) - epsilon
    && point[0] <= Math.max(a[0], b[0]) + epsilon
    && point[1] >= Math.min(a[1], b[1]) - epsilon
    && point[1] <= Math.max(a[1], b[1]) + epsilon;
}

function segmentsIntersect(
  a: SeamPoint2,
  b: SeamPoint2,
  c: SeamPoint2,
  d: SeamPoint2,
  epsilon: number,
): boolean {
  const abC = orient(a, b, c);
  const abD = orient(a, b, d);
  const cdA = orient(c, d, a);
  const cdB = orient(c, d, b);
  if (
    ((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
    && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))
  ) return true;
  return onSegment(a, b, c, epsilon)
    || onSegment(a, b, d, epsilon)
    || onSegment(c, d, a, epsilon)
    || onSegment(c, d, b, epsilon);
}

function contourSelfIntersects(contour: SeamPoint2[], epsilon: number): boolean {
  for (let first = 0; first < contour.length; first += 1) {
    const firstNext = (first + 1) % contour.length;
    for (let second = first + 1; second < contour.length; second += 1) {
      const secondNext = (second + 1) % contour.length;
      if (
        first === second
        || firstNext === second
        || secondNext === first
        || (first === 0 && secondNext === 0)
      ) continue;
      if (segmentsIntersect(
        contour[first],
        contour[firstNext],
        contour[second],
        contour[secondNext],
        epsilon,
      )) return true;
    }
  }
  return false;
}

export function projectSeamLoop(points: readonly SeamPoint3[]): SeamProjection {
  const center: [number, number, number] = [0, 0, 0];
  const normal: [number, number, number] = [0, 0, 0];
  if (points.length < 3) {
    return {
      status: 'degenerate',
      center,
      normal,
      contour: [],
      signedArea2: 0,
      diagonal: 0,
      maxDeviation: 0,
      warpRatio: 0,
    };
  }
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    center[0] += point[0];
    center[1] += point[1];
    center[2] += point[2];
    normal[0] += (point[1] - next[1]) * (point[2] + next[2]);
    normal[1] += (point[2] - next[2]) * (point[0] + next[0]);
    normal[2] += (point[0] - next[0]) * (point[1] + next[1]);
  }
  center[0] /= points.length;
  center[1] /= points.length;
  center[2] /= points.length;
  const normalLength = Math.hypot(normal[0], normal[1], normal[2]);
  if (normalLength <= 1e-9) {
    return {
      status: 'degenerate',
      center,
      normal,
      contour: [],
      signedArea2: 0,
      diagonal: 0,
      maxDeviation: 0,
      warpRatio: 0,
    };
  }
  normal[0] /= normalLength;
  normal[1] /= normalLength;
  normal[2] /= normalLength;
  const helper: [number, number, number] = Math.abs(normal[2]) < 0.82
    ? [0, 0, 1]
    : [0, 1, 0];
  const tangent: [number, number, number] = [
    helper[1] * normal[2] - helper[2] * normal[1],
    helper[2] * normal[0] - helper[0] * normal[2],
    helper[0] * normal[1] - helper[1] * normal[0],
  ];
  const tangentLength = Math.hypot(tangent[0], tangent[1], tangent[2]);
  if (tangentLength <= 1e-9) {
    return {
      status: 'degenerate',
      center,
      normal,
      contour: [],
      signedArea2: 0,
      diagonal: 0,
      maxDeviation: 0,
      warpRatio: 0,
    };
  }
  tangent[0] /= tangentLength;
  tangent[1] /= tangentLength;
  tangent[2] /= tangentLength;
  const bitangent: [number, number, number] = [
    normal[1] * tangent[2] - normal[2] * tangent[1],
    normal[2] * tangent[0] - normal[0] * tangent[2],
    normal[0] * tangent[1] - normal[1] * tangent[0],
  ];
  let maxDeviation = 0;
  const contour = points.map((point): SeamPoint2 => {
    const x = point[0] - center[0];
    const y = point[1] - center[1];
    const z = point[2] - center[2];
    maxDeviation = Math.max(
      maxDeviation,
      Math.abs(x * normal[0] + y * normal[1] + z * normal[2]),
    );
    return [
      x * tangent[0] + y * tangent[1] + z * tangent[2],
      x * bitangent[0] + y * bitangent[1] + z * bitangent[2],
    ];
  });
  const minX = Math.min(...contour.map((point) => point[0]));
  const maxX = Math.max(...contour.map((point) => point[0]));
  const minY = Math.min(...contour.map((point) => point[1]));
  const maxY = Math.max(...contour.map((point) => point[1]));
  const diagonal = Math.max(Math.hypot(maxX - minX, maxY - minY), 1e-6);
  const epsilon = Math.max(1e-7, diagonal * 1e-8);
  let signedArea2 = 0;
  for (let index = 0; index < contour.length; index += 1) {
    const point = contour[index];
    const next = contour[(index + 1) % contour.length];
    signedArea2 += point[0] * next[1] - next[0] * point[1];
  }
  const degenerate = Math.abs(signedArea2) <= epsilon * epsilon;
  const selfIntersection = !degenerate && contourSelfIntersects(contour, epsilon);
  return {
    status: degenerate ? 'degenerate' : selfIntersection ? 'self_intersection' : 'ready',
    center,
    normal,
    contour,
    signedArea2,
    diagonal,
    maxDeviation,
    warpRatio: maxDeviation / diagonal,
  };
}
