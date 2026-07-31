import { describe, expect, it } from 'vitest';
import { completeFaceSetFromRoughMask } from '../src/split/face-set-completion-core';

function makePrism(rings = 8, sides = 24) {
  const positions: number[] = [];
  for (let ring = 0; ring < rings; ring += 1) {
    const x = ring * 10;
    for (let side = 0; side < sides; side += 1) {
      const angle = (side / sides) * Math.PI * 2;
      positions.push(x, Math.cos(angle) * 20, Math.sin(angle) * 20);
    }
  }
  const leftCenter = positions.length / 3;
  positions.push(0, 0, 0);
  const rightCenter = positions.length / 3;
  positions.push((rings - 1) * 10, 0, 0);
  const indices: number[] = [];
  for (let ring = 0; ring < rings - 1; ring += 1) {
    for (let side = 0; side < sides; side += 1) {
      const next = (side + 1) % sides;
      const a = ring * sides + side;
      const d = ring * sides + next;
      const b = (ring + 1) * sides + side;
      const c = (ring + 1) * sides + next;
      indices.push(a, d, b, d, c, b);
    }
  }
  for (let side = 0; side < sides; side += 1) {
    const next = (side + 1) % sides;
    indices.push(leftCenter, next, side);
    const base = (rings - 1) * sides;
    indices.push(rightCenter, base + side, base + next);
  }
  return {
    positions: new Float32Array(positions),
    index: new Uint32Array(indices),
    rings,
    sides,
  };
}

function combinePrisms(
  entries: Array<{
    mesh: ReturnType<typeof makePrism>;
    offset: [number, number, number];
  }>,
) {
  const positions: number[] = [];
  const indices: number[] = [];
  const ranges: Array<{ startFace: number; faceCount: number }> = [];
  for (const entry of entries) {
    const vertexOffset = positions.length / 3;
    const startFace = indices.length / 3;
    for (let offset = 0; offset < entry.mesh.positions.length; offset += 3) {
      positions.push(
        entry.mesh.positions[offset] + entry.offset[0],
        entry.mesh.positions[offset + 1] + entry.offset[1],
        entry.mesh.positions[offset + 2] + entry.offset[2],
      );
    }
    for (const vertex of entry.mesh.index) indices.push(vertex + vertexOffset);
    ranges.push({
      startFace,
      faceCount: entry.mesh.index.length / 3,
    });
  }
  return {
    positions: new Float32Array(positions),
    index: new Uint32Array(indices),
    ranges,
  };
}

describe('M1.11e 粗涂种子与关节环搜索', () => {
  it('uses the joint loop that best matches rough paint and fills a hidden end cap', () => {
    const mesh = makePrism();
    const faceCount = mesh.index.length / 3;
    const rough = new Uint8Array(faceCount);
    const selectedBands = 2;
    rough.fill(1, 0, selectedBands * mesh.sides * 2);
    const result = completeFaceSetFromRoughMask(mesh.positions, mesh.index, rough);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.summary.candidateCount).toBeGreaterThanOrEqual(2);
    expect(result.summary.roughFaces).toBe(selectedBands * mesh.sides * 2);
    expect(result.summary.addedFaces).toBe(mesh.sides);
    expect(result.summary.removedFaces).toBe(0);
    expect(result.summary.completedFaces).toBe(selectedBands * mesh.sides * 2 + mesh.sides);
    expect(result.summary.seamEdges).toBe(mesh.sides);
    expect(result.summary.matchPercent).toBeGreaterThan(85);
    expect(result.loopPositions.length).toBe(mesh.sides * 3);
  });

  it('grows a visible-side rough seed around the hidden back and finds a joint ring', () => {
    const mesh = makePrism(18, 64);
    const faceCount = mesh.index.length / 3;
    const rough = new Uint8Array(faceCount);
    const selectedBands = 5;
    for (let ring = 0; ring < selectedBands; ring += 1) {
      for (let side = 0; side < mesh.sides; side += 1) {
        const midpoint = ((side + 0.5) / mesh.sides) * Math.PI * 2;
        if (Math.cos(midpoint) <= 0) continue;
        const face = (ring * mesh.sides + side) * 2;
        rough[face] = 1;
        rough[face + 1] = 1;
      }
    }

    const result = completeFaceSetFromRoughMask(
      mesh.positions,
      mesh.index,
      rough,
      undefined,
      [0, 200, 0],
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.summary.searchMode).toBe('seed_growth');
    expect(result.summary.growthRings).toBeGreaterThan(0);
    expect(result.summary.addedFaces).toBeGreaterThan(0);
    expect(result.summary.completedFaces).toBeLessThan(faceCount * 0.85);
    expect(result.summary.removedFaces / result.summary.roughFaces).toBeLessThanOrEqual(0.4);
    expect(result.summary.seamEdges).toBeGreaterThanOrEqual(mesh.sides / 2);
  });

  it('ranks up to three safe joint loops near the user anchor', () => {
    const mesh = makePrism(14, 32);
    const rough = new Uint8Array(mesh.index.length / 3);
    rough.fill(1, 0, mesh.sides * 2);
    const anchor: [number, number, number] = [40, 20, 0];

    const result = completeFaceSetFromRoughMask(
      mesh.positions,
      mesh.index,
      rough,
      undefined,
      null,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      anchor,
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.summary.anchorDistanceMm).toBeLessThanOrEqual(10);
    expect(result.summary.optionIndex).toBe(0);
    expect(result.summary.optionCount).toBeGreaterThanOrEqual(2);
    expect(result.summary.optionCount).toBeLessThanOrEqual(3);
    expect(result.alternatives?.length).toBe((result.summary.optionCount ?? 1) - 1);
    const loopCenters = [result, ...(result.alternatives ?? [])].map((option) => {
      let x = 0;
      for (let offset = 0; offset < option.loopPositions.length; offset += 3) {
        x += option.loopPositions[offset];
      }
      return Number((x / (option.loopPositions.length / 3)).toFixed(3));
    });
    expect(new Set(loopCenters).size).toBe(loopCenters.length);
    for (const alternative of result.alternatives ?? []) {
      expect(alternative.summary.anchorDistanceMm).toBeLessThanOrEqual(20);
      expect(alternative.loopPositions.length).toBeGreaterThan(0);
    }
  });

  it('fails closed when rough paint has no closed boundary candidate', () => {
    const positions = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]);
    const result = completeFaceSetFromRoughMask(
      positions,
      null,
      new Uint8Array([1, 0]),
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.code).toBe('no_closed_candidate');
  });

  it('rejects a candidate that would turn the rough patch into nearly the whole model', () => {
    const mesh = makePrism();
    const faceCount = mesh.index.length / 3;
    const rough = new Uint8Array(faceCount);
    rough.fill(1);
    const sideFaceCount = (mesh.rings - 1) * mesh.sides * 2;
    for (let side = 0; side < mesh.sides; side += 1) {
      rough[sideFaceCount + side * 2] = 0;
    }

    const result = completeFaceSetFromRoughMask(mesh.positions, mesh.index, rough);

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.code).toBe('unsafe_expansion');
    expect(result.message).toContain('已保留原始粗涂');
    expect(result.details?.proposedFaces).toBe(faceCount - mesh.sides);
    expect(result.details?.safeFaceLimit).toBeLessThan(faceCount - mesh.sides);
  });

  it('completes a non-indexed 100k-face figurine-style mesh above the old realtime limit', () => {
    const mesh = makePrism(52, 1024);
    const faceCount = mesh.index.length / 3;
    expect(faceCount).toBeGreaterThan(100_000);
    const nonIndexed = new Float32Array(faceCount * 9);
    for (let corner = 0; corner < mesh.index.length; corner += 1) {
      const source = mesh.index[corner] * 3;
      nonIndexed[corner * 3] = mesh.positions[source];
      nonIndexed[corner * 3 + 1] = mesh.positions[source + 1];
      nonIndexed[corner * 3 + 2] = mesh.positions[source + 2];
    }
    const rough = new Uint8Array(faceCount);
    const selectedBands = 3;
    rough.fill(1, 0, selectedBands * mesh.sides * 2);
    const result = completeFaceSetFromRoughMask(nonIndexed, null, rough);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.summary.seamEdges).toBe(mesh.sides);
    expect(result.summary.addedFaces).toBe(mesh.sides);
    expect(result.summary.completedFaces).toBe(selectedBands * mesh.sides * 2 + mesh.sides);
  });

  it('searches behind a visible seed on a non-indexed 100k-face mesh', () => {
    const mesh = makePrism(52, 1024);
    const faceCount = mesh.index.length / 3;
    const nonIndexed = new Float32Array(faceCount * 9);
    for (let corner = 0; corner < mesh.index.length; corner += 1) {
      const source = mesh.index[corner] * 3;
      nonIndexed[corner * 3] = mesh.positions[source];
      nonIndexed[corner * 3 + 1] = mesh.positions[source + 1];
      nonIndexed[corner * 3 + 2] = mesh.positions[source + 2];
    }
    const rough = new Uint8Array(faceCount);
    const selectedBands = 20;
    for (let ring = 0; ring < selectedBands; ring += 1) {
      for (let side = 0; side < mesh.sides; side += 1) {
        const midpoint = ((side + 0.5) / mesh.sides) * Math.PI * 2;
        if (Math.cos(midpoint) <= 0) continue;
        const face = (ring * mesh.sides + side) * 2;
        rough[face] = 1;
        rough[face + 1] = 1;
      }
    }

    const result = completeFaceSetFromRoughMask(
      nonIndexed,
      null,
      rough,
      undefined,
      [0, 200, 0],
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.summary.searchMode).toBe('seed_growth');
    expect(result.summary.growthRings).toBeGreaterThan(0);
    expect(result.summary.completedFaces).toBeGreaterThan(result.summary.roughFaces);
    expect(result.summary.completedFaces).toBeLessThanOrEqual(500_000);
    expect(result.summary.removedFaces / result.summary.roughFaces).toBeLessThanOrEqual(0.4);
  });

  it('expands rough paint to complete disconnected mechanical shells without inventing a seam', () => {
    const combined = combinePrisms([
      { mesh: makePrism(12, 24), offset: [0, 0, 0] },
      { mesh: makePrism(5, 16), offset: [0, 80, 0] },
      { mesh: makePrism(4, 12), offset: [50, 80, 0] },
    ]);
    const rough = new Uint8Array(combined.index.length / 3);
    for (const range of combined.ranges.slice(1)) {
      rough.fill(1, range.startFace, range.startFace + Math.ceil(range.faceCount / 2));
    }

    const result = completeFaceSetFromRoughMask(
      combined.positions,
      combined.index,
      rough,
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.summary.splitMode).toBe('shells');
    expect(result.summary.sourceShellCount).toBe(3);
    expect(result.summary.selectedShellCount).toBe(2);
    expect(result.summary.seamEdges).toBe(0);
    expect(result.loopPositions.length).toBe(0);
    for (const range of combined.ranges.slice(1)) {
      expect(
        result.faceLabels.slice(range.startFace, range.startFace + range.faceCount)
          .every((value) => value === 1),
      ).toBe(true);
    }
    expect(
      result.faceLabels.slice(
        combined.ranges[0].startFace,
        combined.ranges[0].startFace + combined.ranges[0].faceCount,
      ).every((value) => value === 0),
    ).toBe(true);
  });

  it('combines complete accessory shells with one bridge-shell joint cut', () => {
    const body = makePrism(12, 32);
    const accessory = makePrism(4, 12);
    const combined = combinePrisms([
      { mesh: body, offset: [0, 0, 0] },
      { mesh: accessory, offset: [40, 80, 0] },
    ]);
    const rough = new Uint8Array(combined.index.length / 3);
    const bodyBands = 2;
    rough.fill(1, 0, bodyBands * body.sides * 2);
    const accessoryRange = combined.ranges[1];
    rough.fill(
      1,
      accessoryRange.startFace,
      accessoryRange.startFace + Math.ceil(accessoryRange.faceCount / 2),
    );

    const result = completeFaceSetFromRoughMask(
      combined.positions,
      combined.index,
      rough,
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.summary.splitMode).toBe('hybrid');
    expect(result.summary.sourceShellCount).toBe(2);
    expect(result.summary.selectedShellCount).toBe(1);
    expect(result.summary.fullShellFaces).toBe(accessoryRange.faceCount);
    expect(result.summary.seamEdges).toBe(body.sides);
    expect(
      result.faceLabels.slice(
        accessoryRange.startFace,
        accessoryRange.startFace + accessoryRange.faceCount,
      ).every((value) => value === 1),
    ).toBe(true);
  });
});
