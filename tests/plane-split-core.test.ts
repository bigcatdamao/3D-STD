import { describe, expect, it } from 'vitest';
import { BoxGeometry, Matrix4, Vector3 } from 'three';
import { splitMeshByPlane } from '../src/split/plane-split-core';

function geometryInput(geometry: BoxGeometry) {
  const position = geometry.getAttribute('position');
  return {
    positions: position.array,
    index: geometry.index?.array ?? null,
  };
}

describe('splitMeshByPlane', () => {
  it('splits and caps a box with a horizontal plane', () => {
    const geometry = new BoxGeometry(20, 30, 40);
    const result = splitMeshByPlane({
      ...geometryInput(geometry),
      plane: { normal: [0, 0, 1], constant: 0 },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.loopCount).toBe(1);
    expect(result.partA.faceCount).toBeGreaterThan(0);
    expect(result.partB.faceCount).toBeGreaterThan(0);
    expect(result.partA.capFaceCount).toBe(2);
    expect(result.partB.capFaceCount).toBe(2);
    expect(result.partA.bounds.min[2]).toBeCloseTo(0, 5);
    expect(result.partA.bounds.max[2]).toBeCloseTo(20, 5);
    expect(result.partB.bounds.min[2]).toBeCloseTo(-20, 5);
    expect(result.partB.bounds.max[2]).toBeCloseTo(0, 5);
  });

  it('supports a rotated arbitrary plane', () => {
    const geometry = new BoxGeometry(20, 20, 20);
    const normal = new Vector3(1, 1, 1).normalize();
    const result = splitMeshByPlane({
      ...geometryInput(geometry),
      plane: { normal: [normal.x, normal.y, normal.z], constant: 0 },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.loopCount).toBe(1);
    expect(result.partA.capFaceCount).toBeGreaterThanOrEqual(3);
    expect(result.partB.capFaceCount).toBe(result.partA.capFaceCount);
  });

  it('supports non-indexed geometry', () => {
    const geometry = new BoxGeometry(10, 10, 10).toNonIndexed();
    const result = splitMeshByPlane({
      positions: geometry.getAttribute('position').array,
      plane: { normal: [1, 0, 0], constant: -1.25 },
    });

    expect(result.status).toBe('ready');
  });

  it('cuts cleanly when the plane follows existing manifold edges', () => {
    const positions = new Float32Array([
      0, 0, 10,
      0, 0, -10,
      10, 0, 0,
      0, 10, 0,
      -10, 0, 0,
      0, -10, 0,
    ]);
    const index = new Uint32Array([
      0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 2,
      1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 2, 5,
    ]);
    const result = splitMeshByPlane({
      positions,
      index,
      plane: { normal: [0, 0, 1], constant: 0 },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.loopCount).toBe(1);
    expect(result.partA.capFaceCount).toBe(2);
    expect(result.partB.capFaceCount).toBe(2);
  });

  it('blocks a plane outside the model', () => {
    const geometry = new BoxGeometry(10, 10, 10);
    const result = splitMeshByPlane({
      ...geometryInput(geometry),
      plane: { normal: [0, 0, 1], constant: -30 },
    });

    expect(result).toMatchObject({ status: 'blocked', code: 'no_intersection' });
  });

  it('blocks an ambiguous plane that lies on complete mesh edges', () => {
    const geometry = new BoxGeometry(10, 10, 10);
    const result = splitMeshByPlane({
      ...geometryInput(geometry),
      plane: { normal: [0, 0, 1], constant: -5 },
    });

    expect(result).toMatchObject({ status: 'blocked', code: 'coplanar_ambiguity' });
  });

  it('normalizes plane normals without changing the cut', () => {
    const geometry = new BoxGeometry(12, 14, 16);
    const result = splitMeshByPlane({
      ...geometryInput(geometry),
      plane: { normal: [0, 0, 3], constant: 0 },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.partA.bounds.dimensions[2]).toBeCloseTo(8, 5);
  });

  it('keeps geometry in the source local coordinate system', () => {
    const geometry = new BoxGeometry(20, 20, 20);
    geometry.applyMatrix4(new Matrix4().makeTranslation(4, -3, 7));
    const result = splitMeshByPlane({
      ...geometryInput(geometry),
      plane: { normal: [0, 0, 1], constant: -7 },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.partA.bounds.min[2]).toBeCloseTo(7, 5);
    expect(result.partB.bounds.max[2]).toBeCloseTo(7, 5);
  });
});
