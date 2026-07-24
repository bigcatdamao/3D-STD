import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlaneSplitRunner, type PlaneSplitWorkerLike } from '../src/split/plane-split-runner';
import type { PlaneSplitReply, PlaneSplitRequest } from '../src/split/plane-split-protocol';
import {
  _injectPlaneSplitRunner,
  cancelManualPlaneSplit,
  confirmManualPlaneSplit,
  setManualPlaneAxis,
  startManualPlaneSplit,
  useManualPlaneSplit,
  worldPlaneToAssetPlane,
} from '../src/split/manual-plane-split-state';
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

afterEach(() => {
  cancelManualPlaneSplit();
  _injectPlaneSplitRunner(null);
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
});
