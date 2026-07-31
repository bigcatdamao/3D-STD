import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyFacePaintSample,
  boundarySegmentsFromTopology,
  buildLocalFacePaintTopology,
  buildFacePaintTopology,
  connectedSurfaceCandidates,
  faceCountOfGeometry,
} from '../src/split/face-paint-core';
import {
  applyFacePaintFaces,
  beginFacePaintStroke,
  clearFacePaintMask,
  commitFacePaintStroke,
  getFacePaintMask,
  initializeFacePaintSession,
  resetFacePaintSession,
  undoFacePaintStroke,
  useFacePaint,
} from '../src/split/face-paint-state';

afterEach(resetFacePaintSession);

describe('M1.11a 面组画笔核心', () => {
  it('adds and erases faces while recording each face once per stroke', () => {
    const mask = new Uint8Array(4);
    const changes = new Map<number, 0 | 1>();
    expect(applyFacePaintSample(mask, [0, 1, 1, 9], 'add', changes)).toEqual([0, 1]);
    expect(applyFacePaintSample(mask, [1, 2], 'add', changes)).toEqual([2]);
    expect([...mask]).toEqual([1, 1, 1, 0]);
    expect([...changes]).toEqual([[0, 0], [1, 0], [2, 0]]);
    expect(applyFacePaintSample(mask, [1], 'erase', changes)).toEqual([1]);
    expect(changes.get(1)).toBe(0);
  });

  it('extracts the visible border between a painted and an unpainted triangle', () => {
    const geometry = new THREE.PlaneGeometry(2, 2, 1, 1);
    expect(faceCountOfGeometry(geometry)).toBe(2);
    const topology = buildFacePaintTopology(geometry);
    const boundary = boundarySegmentsFromTopology(topology, new Uint8Array([1, 0]));
    expect(boundary.status).toBe('ready');
    expect(boundary.segmentCount).toBe(3);
    expect(boundary.positions.length).toBe(18);
    geometry.dispose();
  });

  it('keeps a brush sample on the connected hit surface instead of painting a nearby back shell', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0.05, 0, 1, 0.05, 1, 0, 0.05,
    ], 3));
    expect(connectedSurfaceCandidates(geometry, [0, 1], 0)).toEqual([0]);
    geometry.dispose();
  });

  it('skips explicit boundary topology above the performance budget', () => {
    const geometry = new THREE.PlaneGeometry(2, 2, 1, 1);
    const topology = buildFacePaintTopology(geometry, 1);
    const boundary = boundarySegmentsFromTopology(topology, new Uint8Array([1, 0]));
    expect(topology).toBeNull();
    expect(boundary.status).toBe('budget');
    geometry.dispose();
  });

  it('rebuilds only the painted patch topology for an explicit high-poly seam request', () => {
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    const mask = new Uint8Array(faceCountOfGeometry(geometry));
    const position = geometry.getAttribute('position');
    const indexAt = (corner: number) => geometry.index ? geometry.index.getX(corner) : corner;
    for (let face = 0; face < mask.length; face += 1) {
      const a = new THREE.Vector3().fromBufferAttribute(position, indexAt(face * 3));
      const b = new THREE.Vector3().fromBufferAttribute(position, indexAt(face * 3 + 1));
      const c = new THREE.Vector3().fromBufferAttribute(position, indexAt(face * 3 + 2));
      if (b.sub(a).cross(c.sub(a)).normalize().z > 0.9) mask[face] = 1;
    }
    expect(buildFacePaintTopology(geometry, 1)).toBeNull();
    const topology = buildLocalFacePaintTopology(geometry, mask, mask.length, mask.length);
    const boundary = boundarySegmentsFromTopology(topology, mask);
    expect(topology).not.toBeNull();
    expect(topology!.edges.length).toBeLessThan(36);
    expect(boundary.status).toBe('ready');
    expect(boundary.segmentCount).toBe(4);
    geometry.dispose();
  });

  it('commits a whole drag as one paint undo step and keeps clear undoable', () => {
    initializeFacePaintSession('instance-1', 'asset-1', 6, 8);
    expect(beginFacePaintStroke()).toBe(true);
    applyFacePaintFaces([0, 1, 2], 'add');
    applyFacePaintFaces([2, 3], 'add');
    expect(commitFacePaintStroke()).toBe(true);
    expect([...getFacePaintMask()!]).toEqual([1, 1, 1, 1, 0, 0]);
    expect(useFacePaint.getState().strokeCount).toBe(1);
    expect(useFacePaint.getState().paintedFaceCount).toBe(4);

    expect(clearFacePaintMask()).toBe(true);
    expect(useFacePaint.getState().paintedFaceCount).toBe(0);
    expect(undoFacePaintStroke()).toBe(true);
    expect([...getFacePaintMask()!]).toEqual([1, 1, 1, 1, 0, 0]);
    expect(undoFacePaintStroke()).toBe(true);
    expect([...getFacePaintMask()!]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
