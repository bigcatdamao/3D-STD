import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CheckRunner, type CheckWorkerLike } from '../src/check/check-runner';
import { _injectRunner, useCheck } from '../src/check/check-state';
import type { CheckIssue } from '../src/check/check-core';
import { dispatch, doc, geometryRegistry, useUi } from '../src/state/store';
import {
  applyMeshRepair,
  getRepairAddedGeometry,
  prepareMeshRepair,
  useMeshRepair,
} from '../src/repair/mesh-repair-state';

function openBox(): THREE.BufferGeometry {
  const x = 12, y = 12, z = 8;
  const a = [-x, -y, -z], b = [x, -y, -z], c = [x, y, -z], d = [-x, y, -z];
  const e = [-x, -y, z], f = [x, -y, z], g = [x, y, z], h = [-x, y, z];
  const triangles = [
    [a, d, c], [a, c, b], [a, b, f], [a, f, e], [b, c, g],
    [b, g, f], [c, d, h], [c, h, g], [d, a, e], [d, e, h],
  ];
  const positions = new Float32Array(triangles.flat(2));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

class ImmediateCheckWorker implements CheckWorkerLike {
  onmessage: CheckWorkerLike['onmessage'] = null;
  onerror: CheckWorkerLike['onerror'] = null;
  postMessage(message: unknown) {
    const run = message as { runId: string; instances: { id: string; name: string; assetId: string }[] };
    queueMicrotask(() => {
      for (const instance of run.instances) {
        this.onmessage?.({
          data: {
            t: 'instance',
            runId: run.runId,
            issues: [{
              key: `dims:${instance.id}`,
              code: 'dims',
              level: 'info',
              instanceId: instance.id,
              instanceName: instance.name,
              assetId: instance.assetId,
              message: '24.0 × 24.0 × 16.0 mm · 12 面',
            }],
          },
        });
      }
      this.onmessage?.({
        data: {
          t: 'done',
          runId: run.runId,
          summary: {
            instances: run.instances.length,
            errors: 0,
            warnings: 0,
            totalFaces: 12,
            assetsAnalyzed: 1,
            assetsCached: 0,
            durationMs: 1,
          },
        },
      });
    });
  }
  terminate() {}
}

describe('M1.7 修复预览到派生副本闭环', () => {
  it('预览零修改，确认后切换派生资产，自动复检，撤销恢复原资产', async () => {
    _injectRunner(new CheckRunner(() => new ImmediateCheckWorker(), 1000));
    const geometry = openBox();
    const asset = dispatch((scene) => scene.addAsset({
      name: '开口盒',
      source: 'import',
      state: 'ready',
      meta: {
        faces: 10,
        vertices: 8,
        bbox: { min: [-12, -12, -8], max: [12, 12, 8] },
        unitChoice: 'mm',
        watertight: false,
        degenerate: false,
      },
    }));
    geometryRegistry.set(asset.id, geometry);
    const instance = dispatch((scene) => scene.placeInstance(asset.id, '导入', 'place', [0, 0, 8]));
    const issue: CheckIssue = {
      key: `non_watertight:${instance.id}`,
      code: 'non_watertight',
      level: 'error',
      instanceId: instance.id,
      instanceName: instance.name,
      assetId: asset.id,
      message: '非水密网格(4 条开放边界边)',
    };
    useCheck.setState({
      phase: 'done',
      panelOpen: true,
      issues: [issue],
      runMeta: { editVersion: doc.editVersion, bed: { ...useUi.getState().bed } },
    });

    const historyBeforePreview = doc.history.length;
    expect(prepareMeshRepair(issue)).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(useMeshRepair.getState().phase).toBe('ready');
    expect(getRepairAddedGeometry()?.getAttribute('position').count).toBe(6);
    expect(doc.history.length).toBe(historyBeforePreview);
    expect(doc.instance(instance.id).assetId).toBe(asset.id);

    expect(applyMeshRepair()).toBe(true);
    const repairedId = doc.instance(instance.id).assetId;
    expect(repairedId).not.toBe(asset.id);
    expect(doc.assets.has(asset.id)).toBe(true);
    expect(doc.assets.get(repairedId)?.meta).toMatchObject({ faces: 12, watertight: true, degenerate: false });
    expect(geometryRegistry.has(repairedId)).toBe(true);
    expect(doc.history.list().at(-1)).toMatchObject({ op: 'fix', label: '生成网格修复副本' });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useCheck.getState().phase).toBe('done');
    expect(useCheck.getState().summary?.errors).toBe(0);

    doc.history.undo();
    expect(doc.instance(instance.id).assetId).toBe(asset.id);
    expect(doc.assets.has(repairedId)).toBe(false);
  });
});
