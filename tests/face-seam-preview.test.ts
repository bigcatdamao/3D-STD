import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildFacePaintTopology, faceCountOfGeometry } from '../src/split/face-paint-core';
import {
  createFaceSeamPreview,
  createShellGroupPreview,
  type FaceSeamIssueCode,
} from '../src/split/face-seam-preview-core';
import {
  _injectFaceSeamRunner,
  applyFacePaintFaces,
  beginFacePaintStroke,
  commitFacePaintStroke,
  generateFacePaintSeamPreview,
  getFacePaintMask,
  initializeFacePaintSession,
  registerFacePaintGeometry,
  resetFacePaintSession,
  returnFacePaintToEditing,
  selectFacePaintSeamChoice,
  useFacePaint,
} from '../src/split/face-paint-state';
import { FaceSeamRunner, type FaceSeamWorkerLike } from '../src/split/face-seam-runner';
import type { FaceSeamReply, FaceSeamRequest } from '../src/split/face-seam-protocol';

afterEach(() => {
  _injectFaceSeamRunner(null);
  resetFacePaintSession();
});

class InvalidCompletionWorker implements FaceSeamWorkerLike {
  onmessage: ((event: { data: FaceSeamReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  postMessage(message: unknown): void {
    const request = message as FaceSeamRequest;
    queueMicrotask(() => {
      const completed = new Uint8Array([1, 1, 1, 1]);
      this.onmessage?.({
        data: {
          t: 'result',
          requestId: request.requestId,
          result: createFaceSeamPreview(null, completed),
          durationMs: 8,
          completedFaceLabels: completed.buffer,
          completion: {
            candidateCount: 1,
            branchPoints: 0,
            roughFaces: 2,
            completedFaces: 4,
            addedFaces: 2,
            removedFaces: 0,
            matchPercent: 40,
            seamEdges: 3,
            seamLengthLocal: 2,
            searchMode: 'rough_boundary',
            growthRings: 0,
            splitMode: 'surface',
            sourceShellCount: 1,
            selectedShellCount: 0,
            fullShellFaces: 0,
            bridgeShellFaces: 4,
          },
        },
      });
    });
  }

  terminate(): void {}
}

class CandidateCompletionWorker implements FaceSeamWorkerLike {
  onmessage: ((event: { data: FaceSeamReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  postMessage(message: unknown): void {
    const request = message as FaceSeamRequest;
    const readyResult = (paintedFaces: number) => ({
      status: 'ready' as const,
      loopPositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
      issues: [],
      warnings: [],
      metrics: {
        paintedFaces,
        remainingFaces: 12 - paintedFaces,
        paintedRatio: paintedFaces / 12,
        boundaryVertices: 3,
        seamLengthMm: 3,
        maxPlanarityDeviationMm: 0,
        selectionMinDimensionMm: 1,
        selectionMaxDimensionMm: 2,
        componentCount: 1,
      },
    });
    const summary = (completedFaces: number, optionIndex: number) => ({
      candidateCount: 3,
      branchPoints: 0,
      roughFaces: 2,
      completedFaces,
      addedFaces: completedFaces - 2,
      removedFaces: 0,
      matchPercent: 90 - optionIndex,
      seamEdges: 3,
      seamLengthLocal: 3,
      searchMode: 'seed_growth' as const,
      growthRings: 8 + optionIndex,
      splitMode: 'surface' as const,
      sourceShellCount: 1,
      selectedShellCount: 0,
      fullShellFaces: 0,
      bridgeShellFaces: completedFaces,
      anchorDistanceMm: optionIndex + 1,
      optionIndex,
      optionCount: 2,
    });
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          t: 'result',
          requestId: request.requestId,
          result: readyResult(4),
          durationMs: 9,
          completedFaceLabels: new Uint8Array([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]).buffer,
          completion: summary(4, 0),
          alternatives: [{
            result: readyResult(6),
            completedFaceLabels: new Uint8Array([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]).buffer,
            completion: summary(6, 1),
          }],
        },
      });
    });
  }

  terminate(): void {}
}

function faceNormal(geometry: THREE.BufferGeometry, faceIndex: number): THREE.Vector3 {
  const position = geometry.getAttribute('position');
  const indexAt = (corner: number) => geometry.index ? geometry.index.getX(corner) : corner;
  const a = new THREE.Vector3().fromBufferAttribute(position, indexAt(faceIndex * 3));
  const b = new THREE.Vector3().fromBufferAttribute(position, indexAt(faceIndex * 3 + 1));
  const c = new THREE.Vector3().fromBufferAttribute(position, indexAt(faceIndex * 3 + 2));
  return b.sub(a).cross(c.sub(a)).normalize();
}

function maskForNormals(
  geometry: THREE.BufferGeometry,
  predicate: (normal: THREE.Vector3) => boolean,
): Uint8Array {
  const mask = new Uint8Array(faceCountOfGeometry(geometry));
  for (let faceIndex = 0; faceIndex < mask.length; faceIndex += 1) {
    if (predicate(faceNormal(geometry, faceIndex))) mask[faceIndex] = 1;
  }
  return mask;
}

function issueCodes(result: ReturnType<typeof createFaceSeamPreview>): FaceSeamIssueCode[] {
  return result.issues.map((issue) => issue.code);
}

describe('M1.11b 接缝预览核心', () => {
  it('M1.11f 将多个完整独立壳体作为无需切口的有效预览', () => {
    const result = createShellGroupPreview(new Uint8Array([1, 1, 0, 0]), 2);

    expect(result.status).toBe('ready');
    expect(result.issues).toEqual([]);
    expect(result.loopPositions.length).toBe(0);
    expect(result.metrics.boundaryVertices).toBe(0);
    expect(result.metrics.componentCount).toBe(2);
    expect(result.metrics.paintedFaces).toBe(2);
    expect(result.metrics.remainingFaces).toBe(2);
  });

  it('orders one painted cube side into one closed read-only seam', () => {
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    const topology = buildFacePaintTopology(geometry);
    const mask = maskForNormals(geometry, (normal) => normal.z > 0.9);
    const result = createFaceSeamPreview(topology, mask);

    expect(result.status).toBe('ready');
    expect(result.issues).toEqual([]);
    expect(result.metrics.componentCount).toBe(1);
    expect(result.metrics.boundaryVertices).toBe(4);
    expect(result.metrics.seamLengthMm).toBeCloseTo(80, 5);
    expect(result.metrics.maxPlanarityDeviationMm).toBeCloseTo(0, 5);
    expect(result.loopPositions.length).toBe(12);
    geometry.dispose();
  });

  it('rejects two independent closed loops', () => {
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    const topology = buildFacePaintTopology(geometry);
    const mask = maskForNormals(geometry, (normal) => Math.abs(normal.z) > 0.9);
    const result = createFaceSeamPreview(topology, mask);

    expect(result.status).toBe('invalid');
    expect(result.metrics.componentCount).toBe(2);
    expect(issueCodes(result)).toContain('multiple_loops');
    geometry.dispose();
  });

  it('rejects an open source surface touched by the painted patch', () => {
    const geometry = new THREE.PlaneGeometry(10, 10, 1, 1);
    const topology = buildFacePaintTopology(geometry);
    const result = createFaceSeamPreview(topology, new Uint8Array([1, 0]));

    expect(result.status).toBe('invalid');
    expect(issueCodes(result)).toContain('source_open');
    expect(issueCodes(result)).toContain('open_boundary');
    geometry.dispose();
  });

  it('reports open and branched boundary vertices deterministically', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      2, 0, 0,
      1, 1, 0,
    ], 3));
    const topology = {
      geometry,
      faceCount: 2,
      vertexPositions: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        2, 0, 0,
        1, 1, 0,
      ]),
      edges: [
        { a: 0, b: 1, idA: 0, idB: 1, faces: [0, 1] },
        { a: 1, b: 2, idA: 1, idB: 2, faces: [0, 1] },
        { a: 1, b: 3, idA: 1, idB: 3, faces: [0, 1] },
      ],
    };
    const result = createFaceSeamPreview(topology, new Uint8Array([1, 0]));

    expect(result.status).toBe('invalid');
    expect(issueCodes(result)).toContain('open_boundary');
    expect(issueCodes(result)).toContain('branched_boundary');
    geometry.dispose();
  });

  it('rejects a painted disconnected shell that has no shared seam', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      5, 0, 0, 6, 0, 0, 5, 1, 0,
    ], 3));
    const topology = {
      geometry,
      faceCount: 2,
      vertexPositions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        5, 0, 0, 6, 0, 0, 5, 1, 0,
      ]),
      edges: [],
    };
    const result = createFaceSeamPreview(topology, new Uint8Array([1, 0]));

    expect(result.status).toBe('invalid');
    expect(issueCodes(result)).toContain('degenerate_loop');
    geometry.dispose();
  });

  it('freezes a valid preview and invalidates it when returning to paint', () => {
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    const mask = maskForNormals(geometry, (normal) => normal.z > 0.9);
    initializeFacePaintSession('instance-1', 'asset-1', mask.length, 5);
    registerFacePaintGeometry(geometry);
    expect(beginFacePaintStroke()).toBe(true);
    applyFacePaintFaces([...mask.keys()].filter((index) => mask[index] === 1));
    expect(commitFacePaintStroke()).toBe(true);

    const result = generateFacePaintSeamPreview();
    expect(result?.status).toBe('ready');
    expect(useFacePaint.getState().seamStatus).toBe('ready');
    expect(beginFacePaintStroke()).toBe(false);

    returnFacePaintToEditing();
    expect(useFacePaint.getState().seamStatus).toBe('idle');
    expect(beginFacePaintStroke()).toBe(true);
    geometry.dispose();
  });

  it('keeps the original rough mask when a worker completion fails validation', async () => {
    const geometry = new THREE.TetrahedronGeometry(10, 0);
    const faceCount = faceCountOfGeometry(geometry);
    expect(faceCount).toBe(4);
    initializeFacePaintSession('instance-invalid', 'asset-invalid', faceCount, 5);
    registerFacePaintGeometry(geometry, null);
    expect(beginFacePaintStroke()).toBe(true);
    applyFacePaintFaces([0, 1]);
    expect(commitFacePaintStroke()).toBe(true);
    _injectFaceSeamRunner(new FaceSeamRunner(() => new InvalidCompletionWorker(), 1000));

    expect(generateFacePaintSeamPreview()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect([...getFacePaintMask()!]).toEqual([1, 1, 0, 0]);
    expect(useFacePaint.getState().paintedFaceCount).toBe(2);
    expect(useFacePaint.getState().strokeCount).toBe(1);
    expect(useFacePaint.getState().seamStatus).toBe('invalid');
    geometry.dispose();
  });

  it('switches worker seam candidates without history and restores the rough mask', async () => {
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    const faceCount = faceCountOfGeometry(geometry);
    expect(faceCount).toBe(12);
    initializeFacePaintSession('instance-candidates', 'asset-candidates', faceCount, 5);
    registerFacePaintGeometry(geometry, null);
    expect(beginFacePaintStroke()).toBe(true);
    applyFacePaintFaces([0, 1]);
    expect(commitFacePaintStroke()).toBe(true);
    _injectFaceSeamRunner(new FaceSeamRunner(() => new CandidateCompletionWorker(), 1000));

    expect(generateFacePaintSeamPreview()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useFacePaint.getState().seamChoices).toHaveLength(2);
    expect(useFacePaint.getState().seamChoiceIndex).toBe(0);
    expect([...getFacePaintMask()!]).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(selectFacePaintSeamChoice(1)).toBe(true);
    expect(useFacePaint.getState().seamChoiceIndex).toBe(1);
    expect([...getFacePaintMask()!]).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(useFacePaint.getState().strokeCount).toBe(1);

    returnFacePaintToEditing();
    expect([...getFacePaintMask()!]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(useFacePaint.getState().seamChoices).toHaveLength(0);
    expect(useFacePaint.getState().strokeCount).toBe(1);
    geometry.dispose();
  });
});
