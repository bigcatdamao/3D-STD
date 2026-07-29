import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlaneSplitRunner, type PlaneSplitWorkerLike } from '../src/split/plane-split-runner';
import type { PlaneSplitReply, PlaneSplitRequest } from '../src/split/plane-split-protocol';
import { SurfaceCutRunner, type SurfaceCutWorkerLike } from '../src/split/surface-cut-runner';
import type { SurfaceCutReply, SurfaceCutRequest } from '../src/split/surface-cut-protocol';
import {
  _injectPlaneSplitRunner,
  _injectSurfaceCutRunner,
  appendManualSurfaceGuidePoint,
  cancelManualPlaneSplit,
  clearManualSurfaceGuidePoints,
  confirmManualPlaneSplit,
  confirmManualSurfaceSplit,
  manualSurfaceGuideWorld,
  moveManualSurfaceGuidePoint,
  previewFacePaintSurfaceSplit,
  previewManualSurfaceSplit,
  removeLastManualSurfaceGuidePoint,
  returnManualSurfaceSplitToGuide,
  setManualPlaneAxis,
  startManualPlaneSplit,
  useManualPlaneSplit,
  worldPlaneToAssetPlane,
} from '../src/split/manual-plane-split-state';
import {
  applyFacePaintFaces,
  beginFacePaintStroke,
  commitFacePaintStroke,
  generateFacePaintSeamPreview,
  initializeFacePaintSession,
  registerFacePaintGeometry,
  useFacePaint,
} from '../src/split/face-paint-state';
import { dispatch, doc, geometryRegistry } from '../src/state/store';

class ImmediateSplitWorker implements PlaneSplitWorkerLike {
  onmessage: ((event: MessageEvent<PlaneSplitReply>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  postMessage(request: PlaneSplitRequest) {
    queueMicrotask(() => this.onmessage?.({
      data: {
        t: 'result',
        requestId: request.requestId,
        result: {
          status: 'ready',
          loopCount: 1,
          cutSegmentCount: 8,
          epsilon: 1e-6,
          partA: {
            positions: new Float32Array([
              0, 0, 0, 10, 0, 0, 0, 10, 0,
              0, 0, 0, 0, 10, 0, 0, 0, 10,
              0, 0, 0, 0, 0, 10, 10, 0, 0,
              10, 0, 0, 0, 0, 10, 0, 10, 0,
            ]),
            sourceFaceCount: 2,
            capFaceCount: 2,
            faceCount: 4,
            vertexCount: 4,
            bounds: { min: [0, 0, 0], max: [10, 10, 10], dimensions: [10, 10, 10] },
          },
          partB: {
            positions: new Float32Array([
              0, 0, 0, -10, 0, 0, 0, -10, 0,
              0, 0, 0, 0, -10, 0, 0, 0, -10,
              0, 0, 0, 0, 0, -10, -10, 0, 0,
              -10, 0, 0, 0, 0, -10, 0, -10, 0,
            ]),
            sourceFaceCount: 2,
            capFaceCount: 2,
            faceCount: 4,
            vertexCount: 4,
            bounds: { min: [-10, -10, -10], max: [0, 0, 0], dimensions: [10, 10, 10] },
          },
        },
        durationMs: 5,
      },
    } as MessageEvent<PlaneSplitReply>));
  }
  terminate() {}
}

class ImmediateSurfaceWorker implements SurfaceCutWorkerLike {
  onmessage: ((event: { data: SurfaceCutReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  received: SurfaceCutRequest[] = [];
  postMessage(request: SurfaceCutRequest) {
    this.received.push(request);
    const positionsA = new Float32Array([
      0, 0, 0, 10, 0, 0, 0, 10, 0,
      0, 0, 0, 0, 10, 0, 0, 0, 10,
    ]);
    const positionsB = new Float32Array([
      0, 0, 0, -10, 0, 0, 0, -10, 0,
      0, 0, 0, 0, -10, 0, 0, 0, -10,
    ]);
    queueMicrotask(() => this.onmessage?.({
      data: {
        t: 'result',
        requestId: request.requestId,
        durationMs: 7,
        result: {
          status: 'ready',
          partA: {
            positions: positionsA,
            sourceFaceCount: 1,
            capFaceCount: 1,
            boundaryEdges: 0,
            dimensionsMm: [10, 10, 10],
          },
          partB: {
            positions: positionsB,
            sourceFaceCount: 1,
            capFaceCount: 1,
            boundaryEdges: 0,
            dimensionsMm: [10, 10, 10],
          },
          seamPositions: new Float32Array([0, 0, 0, 0, 10, 0]),
          metrics: {
            sourceFaces: 2,
            partAFaces: 2,
            partBFaces: 2,
            boundaryVertices: 3,
            seamLengthMm: 30,
            guideOffsetMm: 1,
            adaptiveSpanMm: 2,
            meanCreaseDeg: 20,
            searchHalfWidthMm: 12,
            maxCapDeviationMm: 0.2,
            capWarpRatio: 0.01,
            preference: 'balanced',
          },
          warnings: [],
        },
      },
    }));
  }
  terminate() {}
}

afterEach(() => {
  cancelManualPlaneSplit();
  _injectPlaneSplitRunner(null);
  _injectSurfaceCutRunner(null);
});

describe('manual plane split state', () => {
  it('converts a world plane into local asset coordinates under TRS', () => {
    const plane = worldPlaneToAssetPlane(
      {
        position: [10, 20, 30],
        rotation: [0, 0, 90],
        scale: [2, 3, 4],
      },
      [10, 20, 38],
      [0, 0, 0],
    );
    expect(plane.normal[0]).toBeCloseTo(0, 6);
    expect(plane.normal[1]).toBeCloseTo(0, 6);
    expect(plane.normal[2]).toBeCloseTo(1, 6);
    expect(plane.constant).toBeCloseTo(-2, 6);
  });

  it('opens at the selected object center and axis presets rotate the cut frame', () => {
    const geometry = new THREE.BoxGeometry(20, 30, 40);
    const asset = dispatch((scene) => scene.addAsset({
      name: '切割测试',
      source: 'import',
      state: 'ready',
      meta: {
        faces: 12,
        vertices: 8,
        bbox: { min: [-10, -15, -20], max: [10, 15, 20] },
        unitChoice: 'mm',
        watertight: true,
        degenerate: false,
      },
    }));
    geometryRegistry.set(asset.id, geometry);
    const instance = dispatch((scene) => scene.placeInstance(asset.id, '导入', 'place', [4, 5, 20]));

    expect(startManualPlaneSplit(instance.id)).toBe(true);
    expect(useManualPlaneSplit.getState()).toMatchObject({
      phase: 'editing',
      instanceId: instance.id,
      position: [4, 5, 20],
      axis: 'z',
    });
    setManualPlaneAxis('x');
    expect(useManualPlaneSplit.getState()).toMatchObject({
      rotation: [0, 90, 0],
      axis: 'x',
    });
  });

  it('adds, drags and removes surface-snapped control points without writing scene history', () => {
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    const asset = dispatch((scene) => scene.addAsset({
      name: '贴面曲线测试',
      source: 'import',
      state: 'ready',
      meta: {
        faces: 12,
        vertices: 8,
        bbox: { min: [-10, -10, -10], max: [10, 10, 10] },
        unitChoice: 'mm',
        watertight: true,
        degenerate: false,
      },
    }));
    geometryRegistry.set(asset.id, geometry);
    const instance = dispatch((scene) => scene.placeInstance(asset.id));
    const historyBefore = doc.history.length;

    expect(startManualPlaneSplit(instance.id, 'surface')).toBe(true);
    expect(appendManualSurfaceGuidePoint([10, -6, -6])).toBe(true);
    expect(appendManualSurfaceGuidePoint([10, 6, -6])).toBe(true);
    expect(appendManualSurfaceGuidePoint([10, 6, 6])).toBe(true);
    expect(appendManualSurfaceGuidePoint([10, -6, 6])).toBe(true);
    expect(moveManualSurfaceGuidePoint(1, [10, 7, -6])).toBe(true);
    expect(useManualPlaneSplit.getState().surfaceGuidePoints[1]).toEqual([10, 7, -6]);
    const guide = manualSurfaceGuideWorld(
      useManualPlaneSplit.getState().surfaceGuidePoints,
      [0, 0, 0],
      [0, 0, 0],
    );
    expect(Math.abs(guide.normal[0])).toBeCloseTo(1, 5);
    expect(removeLastManualSurfaceGuidePoint()).toBe(true);
    expect(useManualPlaneSplit.getState().surfaceGuidePoints).toHaveLength(3);
    expect(clearManualSurfaceGuidePoints()).toBe(true);
    expect(useManualPlaneSplit.getState().surfaceGuidePoints).toEqual([]);
    expect(doc.history.length).toBe(historyBefore);
  });

  it('confirms into two derived assets and one undo restores the source instance', async () => {
    _injectPlaneSplitRunner(new PlaneSplitRunner(() => new ImmediateSplitWorker(), 1000));
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    const asset = dispatch((scene) => scene.addAsset({
      name: '原模型',
      source: 'import',
      state: 'ready',
      meta: {
        faces: 12,
        vertices: 8,
        bbox: { min: [-10, -10, -10], max: [10, 10, 10] },
        unitChoice: 'mm',
        watertight: true,
        degenerate: false,
      },
    }));
    geometryRegistry.set(asset.id, geometry);
    const instance = dispatch((scene) => scene.placeInstance(asset.id));
    const historyBefore = doc.history.length;

    expect(startManualPlaneSplit(instance.id)).toBe(true);
    expect(confirmManualPlaneSplit()).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(useManualPlaneSplit.getState().phase).toBe('idle');
    expect(doc.history.length).toBe(historyBefore + 1);
    expect(doc.nodes.has(instance.id)).toBe(false);
    const splitInstances = [...doc.selection].map((id) => doc.instance(id));
    expect(splitInstances).toHaveLength(2);
    expect(splitInstances.every((part) => geometryRegistry.has(part.assetId))).toBe(true);

    doc.history.undo();
    expect(doc.nodes.has(instance.id)).toBe(true);
    expect([...doc.selection]).toEqual([instance.id]);
  });

  it('previews an arbitrary-guide surface seam, then confirms the exact A/B result into one undo step', async () => {
    const surfaceWorker = new ImmediateSurfaceWorker();
    _injectSurfaceCutRunner(new SurfaceCutRunner(() => surfaceWorker, 1000));
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    const asset = dispatch((scene) => scene.addAsset({
      name: '曲面源模型',
      source: 'import',
      state: 'ready',
      meta: {
        faces: 12,
        vertices: 8,
        bbox: { min: [-10, -10, -10], max: [10, 10, 10] },
        unitChoice: 'mm',
        watertight: true,
        degenerate: false,
      },
    }));
    geometryRegistry.set(asset.id, geometry);
    const instance = dispatch((scene) => scene.placeInstance(asset.id));
    const historyBefore = doc.history.length;

    expect(startManualPlaneSplit(instance.id, 'surface')).toBe(true);
    expect(appendManualSurfaceGuidePoint([10, -6, -6])).toBe(true);
    expect(appendManualSurfaceGuidePoint([10, 6, -6])).toBe(true);
    expect(appendManualSurfaceGuidePoint([10, 6, 6])).toBe(true);
    expect(appendManualSurfaceGuidePoint([10, -6, 6])).toBe(true);
    expect(previewManualSurfaceSplit()).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(surfaceWorker.received[0].guidePointsWorld).toEqual([
      [10, -6, -6],
      [10, 6, -6],
      [10, 6, 6],
      [10, -6, 6],
    ]);
    expect(useManualPlaneSplit.getState()).toMatchObject({
      phase: 'previewReady',
      cutKind: 'surface',
      durationMs: 7,
    });
    expect(returnManualSurfaceSplitToGuide()).toBe(true);
    expect(useManualPlaneSplit.getState()).toMatchObject({
      phase: 'editing',
      cutKind: 'surface',
      surfaceResult: null,
      durationMs: null,
    });
    expect(doc.history.length).toBe(historyBefore);
    expect(doc.nodes.has(instance.id)).toBe(true);

    expect(previewManualSurfaceSplit()).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(useManualPlaneSplit.getState().phase).toBe('previewReady');
    expect(confirmManualSurfaceSplit()).toBe(true);
    expect(doc.history.length).toBe(historyBefore + 1);
    expect(doc.nodes.has(instance.id)).toBe(false);
    const parts = [...doc.selection].map((id) => doc.instance(id));
    expect(parts).toHaveLength(2);
    expect(parts.every((part) => {
      const split = doc.assets.get(part.assetId)?.genParams?.split as { kind?: string } | undefined;
      return split?.kind === 'surface_adaptive_cut';
    })).toBe(true);

    doc.history.undo();
    expect(doc.nodes.has(instance.id)).toBe(true);
    expect([...doc.selection]).toEqual([instance.id]);
  });

  it('M1.11c uses the verified purple face set for real A/B preview and records one undoable cut', async () => {
    const surfaceWorker = new ImmediateSurfaceWorker();
    _injectSurfaceCutRunner(new SurfaceCutRunner(() => surfaceWorker, 1000));
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    const asset = dispatch((scene) => scene.addAsset({
      name: '面组切割源模型',
      source: 'import',
      state: 'ready',
      meta: {
        faces: 12,
        vertices: 8,
        bbox: { min: [-10, -10, -10], max: [10, 10, 10] },
        unitChoice: 'mm',
        watertight: true,
        degenerate: false,
      },
    }));
    geometryRegistry.set(asset.id, geometry);
    const instance = dispatch((scene) => scene.placeInstance(asset.id));
    const historyBefore = doc.history.length;

    expect(startManualPlaneSplit(instance.id, 'surface')).toBe(true);
    initializeFacePaintSession(instance.id, asset.id, 12, 4);
    registerFacePaintGeometry(geometry);
    expect(beginFacePaintStroke()).toBe(true);
    expect(applyFacePaintFaces([0, 1], 'add')).toEqual([0, 1]);
    expect(commitFacePaintStroke()).toBe(true);
    expect(generateFacePaintSeamPreview(new THREE.Matrix4())?.status).toBe('ready');
    expect(useFacePaint.getState().seamStatus).toBe('ready');

    expect(previewFacePaintSurfaceSplit()).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(surfaceWorker.received[0].guidePointsWorld).toBeUndefined();
    expect(surfaceWorker.received[0].faceLabels).not.toBeNull();
    expect([...new Uint8Array(surfaceWorker.received[0].faceLabels!)]).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(useManualPlaneSplit.getState()).toMatchObject({
      phase: 'previewReady',
      cutKind: 'surface',
      durationMs: 7,
    });
    expect(doc.history.length).toBe(historyBefore);
    expect(doc.nodes.has(instance.id)).toBe(true);

    expect(confirmManualSurfaceSplit()).toBe(true);
    expect(doc.history.length).toBe(historyBefore + 1);
    expect(doc.nodes.has(instance.id)).toBe(false);
    const parts = [...doc.selection].map((id) => doc.instance(id));
    expect(parts).toHaveLength(2);
    const derived = parts.map((part) => doc.assets.get(part.assetId)!);
    expect(derived.map((part) => part.name)).toEqual([
      '面组切割源模型 · A 拆下件',
      '面组切割源模型 · B 保留件',
    ]);
    expect(derived.every((part) => {
      const split = part.genParams?.split as { kind?: string } | undefined;
      return split?.kind === 'face_set_surface_cut';
    })).toBe(true);

    doc.history.undo();
    expect(doc.nodes.has(instance.id)).toBe(true);
    expect([...doc.selection]).toEqual([instance.id]);
  });
});
