import * as THREE from 'three';
import { ADDITION, Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import type { InstanceNode, Transform, Vec3 } from '../kernel/types';

export type ConnectorRole = 'male' | 'female';
export type CandidateRating = 'good' | 'warning' | 'invalid';

export interface ConnectorCandidate {
  instanceId: string;
  point: Vec3;
  normal: Vec3;
  faceIndex: number | null;
  faceAreaMm2: number | null;
  estimatedDepthMm: number;
  recommendedMaxDiameterMm: number;
  rating: CandidateRating;
  message: string;
}

export interface ConnectorParameters {
  diameterMm: number;
  depthMm: number;
  clearanceMm: number;
}

export interface ConnectorBooleanInput {
  first: { geometry: THREE.BufferGeometry; transform: Transform; point: Vec3; normal: Vec3 };
  second: { geometry: THREE.BufferGeometry; transform: Transform; point: Vec3; normal: Vec3 };
  firstRole: ConnectorRole;
  parameters: ConnectorParameters;
}

export interface ConnectorBooleanResult {
  first: THREE.BufferGeometry;
  second: THREE.BufferGeometry;
  axis: Vec3;
  pinDiameterMm: number;
  holeDiameterMm: number;
}

export const MAX_CONNECTOR_INPUT_FACES = 260_000;

/**
 * 第二个点不是任意点：首版只允许在已经摆到装配位置的两件接缝两侧配对。
 * 这道闸门避免“两个布尔都成功，但插销与孔根本不在同一接口”的假成功。
 */
export function assessConnectorPairCandidate(
  first: ConnectorCandidate,
  second: ConnectorCandidate,
  parameters: ConnectorParameters,
): ConnectorCandidate {
  if (second.rating === 'invalid') return second;
  const a = new THREE.Vector3(...first.point);
  const b = new THREE.Vector3(...second.point);
  const gap = a.distanceTo(b);
  const maxGap = THREE.MathUtils.clamp(
    Math.max(parameters.depthMm * 1.5, parameters.diameterMm * 2.5),
    6,
    18,
  );
  if (gap > maxGap) {
    return {
      ...second,
      rating: 'invalid',
      message: `两点相距 ${gap.toFixed(1)} mm，请在同一接缝两侧选择相邻位置（≤ ${maxGap.toFixed(1)} mm）`,
    };
  }
  const firstNormal = new THREE.Vector3(...first.normal).normalize();
  const secondNormal = new THREE.Vector3(...second.normal).normalize();
  if (firstNormal.dot(secondNormal) > -0.15) {
    return {
      ...second,
      rating: 'invalid',
      message: '两个表面没有相向，请旋转模型并在接缝的另一侧重新定位',
    };
  }
  if (gap > 0.2 && firstNormal.dot(b.clone().sub(a).normalize()) < 0.15) {
    return {
      ...second,
      rating: 'invalid',
      message: '第二个点不在第一表面的朝向一侧，请改选接缝内侧表面',
    };
  }
  return {
    ...second,
    message: gap <= 1.5
      ? '两侧接缝已对齐，可进入尺寸设置'
      : `两侧接缝相距 ${gap.toFixed(1)} mm；预览时请确认插销与圆孔同轴`,
  };
}

export function matrixOfTransform(transform: Transform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(transform.rotation[0]),
      THREE.MathUtils.degToRad(transform.rotation[1]),
      THREE.MathUtils.degToRad(transform.rotation[2]),
      'XYZ',
    )),
    new THREE.Vector3(...transform.scale),
  );
}

export function faceCountOf(geometry: THREE.BufferGeometry): number {
  return Math.floor((geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3);
}

function faceAreaInWorld(
  geometry: THREE.BufferGeometry,
  faceIndex: number | null,
  matrixWorld: THREE.Matrix4,
): number | null {
  if (faceIndex == null) return null;
  const position = geometry.getAttribute('position');
  if (!position) return null;
  const index = geometry.index;
  const offset = faceIndex * 3;
  const ai = index ? index.getX(offset) : offset;
  const bi = index ? index.getX(offset + 1) : offset + 1;
  const ci = index ? index.getX(offset + 2) : offset + 2;
  if (ci >= position.count) return null;
  const a = new THREE.Vector3().fromBufferAttribute(position, ai).applyMatrix4(matrixWorld);
  const b = new THREE.Vector3().fromBufferAttribute(position, bi).applyMatrix4(matrixWorld);
  const c = new THREE.Vector3().fromBufferAttribute(position, ci).applyMatrix4(matrixWorld);
  return new THREE.Triangle(a, b, c).getArea();
}

/**
 * 首版采用“点击即验点”，不假装已经完成全模型语义识别。
 * 深度是模型世界包围盒沿法线方向的投影厚度上限；最终仍以布尔预览为准。
 */
export function analyzeConnectorCandidate(
  instance: InstanceNode,
  geometry: THREE.BufferGeometry,
  point: THREE.Vector3,
  normal: THREE.Vector3,
  faceIndex: number | null,
  desiredDiameterMm = 4,
): ConnectorCandidate {
  const matrix = matrixOfTransform(instance.transform);
  const localBox = geometry.boundingBox ?? (geometry.computeBoundingBox(), geometry.boundingBox!);
  const worldBox = localBox.clone().applyMatrix4(matrix);
  const size = worldBox.getSize(new THREE.Vector3());
  const n = normal.clone().normalize();
  const projectedDepth = Math.max(
    Math.abs(n.x) * size.x + Math.abs(n.y) * size.y + Math.abs(n.z) * size.z,
    0,
  );
  const minSpan = Math.max(Math.min(size.x, size.y, size.z), 0);
  const recommendedMax = THREE.MathUtils.clamp(Math.min(minSpan * 0.28, projectedDepth * 0.32), 1.5, 16);
  const faceArea = faceAreaInWorld(geometry, faceIndex, matrix);
  let rating: CandidateRating = 'good';
  let message = '此处空间足够，可进入配对定位';
  if (!Number.isFinite(n.lengthSq()) || n.lengthSq() < 0.9 || projectedDepth < 1) {
    rating = 'invalid';
    message = '无法读取稳定表面方向，请换一个位置';
  } else if (recommendedMax < desiredDiameterMm * 0.72) {
    rating = 'invalid';
    message = '此处局部空间过小，无法容纳当前连接尺寸';
  } else if (recommendedMax < desiredDiameterMm * 1.15) {
    rating = 'warning';
    message = '空间偏紧，建议减小直径或换到更平整区域';
  }
  return {
    instanceId: instance.id,
    point: point.toArray() as Vec3,
    normal: n.toArray() as Vec3,
    faceIndex,
    faceAreaMm2: faceArea,
    estimatedDepthMm: projectedDepth,
    recommendedMaxDiameterMm: recommendedMax,
    rating,
    message,
  };
}

function geometryForCsg(source: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const next = source.clone();
  for (const name of Object.keys(next.attributes)) {
    if (name !== 'position' && name !== 'normal') next.deleteAttribute(name);
  }
  next.clearGroups();
  next.applyMatrix4(matrix);
  if (!next.getAttribute('normal')) next.computeVertexNormals();
  next.computeBoundingBox();
  next.computeBoundingSphere();
  return next;
}

function cylinderAlong(
  from: THREE.Vector3,
  axis: THREE.Vector3,
  diameterMm: number,
  outwardDepthMm: number,
  inwardOverlapMm: number,
): THREE.BufferGeometry {
  const length = outwardDepthMm + inwardOverlapMm;
  const geometry = new THREE.CylinderGeometry(diameterMm / 2, diameterMm / 2, length, 40, 1, false);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  const center = from.clone().addScaledVector(axis, (outwardDepthMm - inwardOverlapMm) / 2);
  geometry.applyQuaternion(quaternion);
  geometry.translate(center.x, center.y, center.z);
  geometry.computeVertexNormals();
  return geometry;
}

function compactResult(source: THREE.BufferGeometry, inverse: THREE.Matrix4): THREE.BufferGeometry {
  const position = source.getAttribute('position');
  const count = Math.min(
    position.count,
    Number.isFinite(source.drawRange.count) ? source.drawRange.count : position.count,
  );
  if (count < 12) throw new Error('布尔结果为空或面数过少，请调整连接点');
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  result.applyMatrix4(inverse);
  result.computeVertexNormals();
  result.computeBoundingBox();
  result.computeBoundingSphere();
  const values = result.getAttribute('position').array;
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) {
      result.dispose();
      throw new Error('布尔结果包含无效坐标，请换一个连接点');
    }
  }
  return result;
}

function evaluate(
  source: THREE.BufferGeometry,
  tool: THREE.BufferGeometry,
  operation: typeof ADDITION | typeof SUBTRACTION,
): THREE.BufferGeometry {
  const sourceBrush = new Brush(source);
  const toolBrush = new Brush(tool);
  sourceBrush.updateMatrixWorld(true);
  toolBrush.updateMatrixWorld(true);
  const evaluator = new Evaluator();
  evaluator.attributes = ['position', 'normal'];
  evaluator.useGroups = false;
  let result: Brush | null = null;
  try {
    result = evaluator.evaluate(sourceBrush, toolBrush, operation);
    return result.geometry.clone();
  } finally {
    source.dispose();
    tool.dispose();
    result?.geometry.dispose();
  }
}

/** 真正修改两侧网格：凸侧做并集，凹侧做差集。结果返回各自实例的局部坐标。 */
export function buildConnectorPair(input: ConnectorBooleanInput): ConnectorBooleanResult {
  const totalFaces = faceCountOf(input.first.geometry) + faceCountOf(input.second.geometry);
  if (totalFaces > MAX_CONNECTOR_INPUT_FACES) {
    throw new Error(`当前两件共 ${totalFaces.toLocaleString()} 面，首版连接器上限为 ${MAX_CONNECTOR_INPUT_FACES.toLocaleString()} 面`);
  }
  const firstPoint = new THREE.Vector3(...input.first.point);
  const secondPoint = new THREE.Vector3(...input.second.point);
  const firstToSecond = secondPoint.clone().sub(firstPoint);
  const pairGap = firstToSecond.length();
  const axis = pairGap >= 0.2
    ? firstToSecond.clone().normalize()
    : new THREE.Vector3(...input.first.normal).normalize();
  if (axis.lengthSq() < 0.9) throw new Error('第一个连接点缺少稳定表面方向，请重新定位');
  const pinDiameter = input.parameters.diameterMm;
  const holeDiameter = pinDiameter + input.parameters.clearanceMm;
  const firstMatrix = matrixOfTransform(input.first.transform);
  const secondMatrix = matrixOfTransform(input.second.transform);
  const maleIsFirst = input.firstRole === 'male';
  const male = maleIsFirst ? input.first : input.second;
  const female = maleIsFirst ? input.second : input.first;
  const maleMatrix = maleIsFirst ? firstMatrix : secondMatrix;
  const femaleMatrix = maleIsFirst ? secondMatrix : firstMatrix;
  const malePoint = maleIsFirst ? firstPoint : secondPoint;
  const femalePoint = maleIsFirst ? secondPoint : firstPoint;
  const maleAxis = maleIsFirst ? axis : axis.clone().negate();
  const overlap = Math.min(Math.max(pinDiameter * 0.28, 0.35), 1.2);

  const maleWorld = geometryForCsg(male.geometry, maleMatrix);
  const femaleWorld = geometryForCsg(female.geometry, femaleMatrix);
  const pin = cylinderAlong(malePoint, maleAxis, pinDiameter, pairGap + input.parameters.depthMm, overlap);
  const hole = cylinderAlong(
    femalePoint,
    maleAxis,
    holeDiameter,
    input.parameters.depthMm + Math.max(input.parameters.clearanceMm, 0.2),
    Math.max(overlap, 0.6),
  );

  let maleResultWorld: THREE.BufferGeometry | null = null;
  let femaleResultWorld: THREE.BufferGeometry | null = null;
  try {
    maleResultWorld = evaluate(maleWorld, pin, ADDITION);
    femaleResultWorld = evaluate(femaleWorld, hole, SUBTRACTION);
    const maleLocal = compactResult(maleResultWorld, maleMatrix.clone().invert());
    const femaleLocal = compactResult(femaleResultWorld, femaleMatrix.clone().invert());
    return {
      first: maleIsFirst ? maleLocal : femaleLocal,
      second: maleIsFirst ? femaleLocal : maleLocal,
      axis: axis.toArray() as Vec3,
      pinDiameterMm: pinDiameter,
      holeDiameterMm: holeDiameter,
    };
  } finally {
    maleResultWorld?.dispose();
    femaleResultWorld?.dispose();
  }
}
