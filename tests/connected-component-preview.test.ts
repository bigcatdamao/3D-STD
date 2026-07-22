import { describe, expect, it } from 'vitest';
import {
  connectedComponentWorldBounds,
  focusConnectedComponent,
  useCheck,
} from '../src/check/check-state';
import type { ConnectedComponentEvidence } from '../src/check/mesh-health-core';
import type { Asset, InstanceNode, Transform } from '../src/kernel/types';
import { doc, onCam, type CamCmd } from '../src/state/store';

const component = (componentIndex: number, minX: number, maxX: number): ConnectedComponentEvidence => ({
  componentIndex,
  faceCount: 12,
  closed: true,
  kind: componentIndex === 1 ? 'primary' : 'separate',
  bounds: { min: [minX, -2, -3], max: [maxX, 2, 3] },
  sourceFaceIndices: [componentIndex - 1],
  previewComplete: true,
});

describe('M1.7.3 连通壳只读拆件预览', () => {
  it('把局部壳包围盒经过旋转和非等比缩放转换成世界 AABB', () => {
    const evidence = component(1, -1, 1);
    const transform: Transform = {
      position: [10, 20, 30],
      rotation: [0, 0, 90],
      scale: [2, 3, 4],
    };
    expect(connectedComponentWorldBounds(evidence, transform)).toEqual({
      min: [4, 18, 18],
      max: [16, 22, 42],
    });
  });

  it('逐壳索引循环并局部聚焦，但不创建零件或写入历史', () => {
    const assetId = 'ast_component_preview_test';
    const instanceId = 'ins_component_preview_test';
    const asset: Asset = {
      id: assetId,
      name: '连通壳测试',
      source: 'import',
      state: 'ready',
      meta: {
        faces: 36,
        bbox: { min: [-12, -2, -3], max: [12, 2, 3] },
        unitChoice: 'mm',
        watertight: true,
        degenerate: false,
      },
    };
    const instance: InstanceNode = {
      kind: 'instance',
      id: instanceId,
      name: '连通壳测试',
      assetId,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
    };
    const components = [component(1, -12, -8), component(2, -2, 2), component(3, 8, 12)];
    doc.hydrate([asset], [instance]);
    useCheck.setState({
      activeKey: null,
      activeEvidenceIndex: 0,
      assetMetas: [{
        assetId,
        faces: 36,
        weldedVertices: 24,
        degenerateCount: 0,
        boundaryEdges: 0,
        nonManifoldEdges: 0,
        watertight: true,
        health: {
          connectedComponents: 3,
          closedComponents: 3,
          componentAnalysisComplete: true,
          componentEvidence: components,
          componentEvidenceComplete: true,
          isolatedFragments: 0,
          isolatedFragmentFaces: 0,
          internalShells: 0,
          selfIntersectionPairs: 0,
          selfIntersectionComplete: true,
          selfIntersectionTrianglesScanned: 36,
          selfIntersectionPairTests: 0,
          selfIntersectionEvidence: [],
        },
        analysisMs: 1,
        cached: false,
      }],
    });
    const issue = {
      key: `dims:${instanceId}`,
      level: 'info' as const,
      code: 'dims' as const,
      instanceId,
      instanceName: instance.name,
      assetId,
      message: '3 个连通壳',
    };
    const before = { version: doc.editVersion, length: doc.history.length, position: doc.history.position };
    const commands: CamCmd[] = [];
    const unsubscribe = onCam((command) => { commands.push(command); });

    expect(focusConnectedComponent(issue, 3)).toBe(true);
    expect(useCheck.getState().activeEvidenceIndex).toBe(0);
    expect(focusConnectedComponent(issue, -1)).toBe(true);
    expect(useCheck.getState().activeEvidenceIndex).toBe(2);
    const focusCommand = commands.at(-1);
    expect(focusCommand).toMatchObject({ kind: 'focusBounds' });
    if (!focusCommand || focusCommand.kind !== 'focusBounds') throw new Error('未发送逐壳局部聚焦命令');
    expect(focusCommand.min[0]).toBeLessThan(8);
    expect(focusCommand.max[0]).toBeGreaterThan(12);
    expect({ version: doc.editVersion, length: doc.history.length, position: doc.history.position }).toEqual(before);
    unsubscribe();
  });
});
