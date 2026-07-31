import type { Vec3 } from '../kernel/types';

export interface AutoSplitRawPart {
  name: string;
  positions: Float32Array;
  normals: Float32Array | null;
}
export interface AutoSplitPreparedPart extends AutoSplitRawPart {
  faces: number;
  bbox: { min: Vec3; max: Vec3 };
}

function bounds(parts: readonly AutoSplitRawPart[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    for (let offset = 0; offset < part.positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], part.positions[offset + axis]);
        max[axis] = Math.max(max[axis], part.positions[offset + axis]);
      }
    }
  }
  return { min, max };
}

const extent = (box: { min: Vec3; max: Vec3 }, axis: number) => box.max[axis] - box.min[axis];

/**
 * 把第三方结果归一回源资产的局部坐标空间。不同 API 可能返回米、毫米或重置中心，
 * 因而不能直接替换场景；统一缩放 + 中心对齐可以保持原实例的变换与摆盘位置。
 */
export function prepareAutoSplitParts(
  raw: readonly AutoSplitRawPart[],
  sourceBounds: { min: Vec3; max: Vec3 },
): AutoSplitPreparedPart[] {
  const valid = raw.filter((part) => part.positions.length >= 9 && part.positions.length % 9 === 0);
  if (valid.length < 2) throw new Error('拆件结果没有识别出至少两个独立零件');
  if (valid.length > 128) throw new Error('拆件结果超过 128 个零件，暂不自动导入');

  const resultBounds = bounds(valid);
  const sourceMax = Math.max(extent(sourceBounds, 0), extent(sourceBounds, 1), extent(sourceBounds, 2));
  const resultMax = Math.max(extent(resultBounds, 0), extent(resultBounds, 1), extent(resultBounds, 2));
  if (!Number.isFinite(sourceMax) || !Number.isFinite(resultMax) || sourceMax <= 0 || resultMax <= 0) {
    throw new Error('拆件结果尺寸无效，源模型保持不变');
  }
  const scale = sourceMax / resultMax;
  if (scale < 1e-6 || scale > 1e6) throw new Error('拆件结果与源模型尺寸差异异常');
  const sourceCenter: Vec3 = [0, 1, 2].map((axis) => (sourceBounds.min[axis] + sourceBounds.max[axis]) / 2) as Vec3;
  const resultCenter: Vec3 = [0, 1, 2].map((axis) => (resultBounds.min[axis] + resultBounds.max[axis]) / 2) as Vec3;

  return valid.map((part, index) => {
    const positions = part.positions.slice();
    for (let offset = 0; offset < positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        positions[offset + axis] = (positions[offset + axis] - resultCenter[axis]) * scale + sourceCenter[axis];
      }
    }
    return {
      name: part.name || `零件 ${index + 1}`,
      positions,
      normals: part.normals ? part.normals.slice() : null,
      faces: positions.length / 9,
      bbox: bounds([{ ...part, positions }]),
    };
  }).sort((a, b) => b.faces - a.faces);
}
