import { describe, expect, it } from 'vitest';
import {
  focusSelfIntersectionEvidence,
  selfIntersectionEvidenceWorldBounds,
  useCheck,
} from '../src/check/check-state';
import type { SelfIntersectionEvidence } from '../src/check/mesh-health-core';
import type { Asset, InstanceNode, Transform } from '../src/kernel/types';
import { doc, onCam, type CamCmd } from '../src/state/store';

describe('M1.7.2 自交证据定位', () => {
  it('把资产局部三角形对的包围盒精确变换到实例世界空间', () => {
    const evidence: SelfIntersectionEvidence = {
      faceA: 1,
      faceB: 2,
      triangleA: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      triangleB: [[0, 0, 1], [1, 0, 1], [0, 1, 1]],
    };
    const transform: Transform = {
      position: [10, 20, 30],
      rotation: [0, 0, 90],
      scale: [2, 3, 4],
    };

    expect(selfIntersectionEvidenceWorldBounds(evidence, transform)).toEqual({
      min: [7, 20, 30],
      max: [10, 22, 34],
    });
  });

  it('命中索引循环并发送局部聚焦命令，但不写场景历史', () => {
    const assetId = 'ast_self_evidence_test';
    const instanceId = 'ins_self_evidence_test';
    const asset: Asset = {
      id: assetId,
      name: '自交测试',
      source: 'import',
      state: 'ready',
      meta: {
        faces: 3,
        bbox: { min: [-2, -2, -1], max: [2, 2, 1] },
        unitChoice: 'mm',
        watertight: false,
        degenerate: false,
      },
    };
    const instance: InstanceNode = {
      kind: 'instance',
      id: instanceId,
      name: '自交测试',
      assetId,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
    };
    const first: SelfIntersectionEvidence = {
      faceA: 1,
      faceB: 2,
      triangleA: [[-2, -2, 0], [2, -2, 0], [0, 2, 0]],
      triangleB: [[-1, 0, -1], [-1, 0, 1], [-1, 1, 0]],
    };
    const second: SelfIntersectionEvidence = {
      ...first,
      faceB: 3,
      triangleB: [[1, 0, -1], [1, 0, 1], [1, 1, 0]],
    };
    doc.hydrate([asset], [instance]);
    useCheck.setState({
      activeKey: null,
      activeEvidenceIndex: 0,
      assetMetas: [{
        assetId,
        faces: 3,
        weldedVertices: 9,
        degenerateCount: 0,
        boundaryEdges: 9,
        nonManifoldEdges: 0,
        watertight: false,
        health: {
          connectedComponents: 3,
          closedComponents: 0,
          componentAnalysisComplete: true,
          isolatedFragments: 0,
          isolatedFragmentFaces: 0,
          internalShells: 0,
          selfIntersectionPairs: 2,
          selfIntersectionComplete: true,
          selfIntersectionTrianglesScanned: 3,
          selfIntersectionPairTests: 2,
          selfIntersectionEvidence: [first, second],
        },
        analysisMs: 1,
        cached: false,
      }],
    });
    const issue = {
      key: `self_intersection:${instanceId}`,
      level: 'error' as const,
      code: 'self_intersection' as const,
      instanceId,
      instanceName: instance.name,
      assetId,
      message: '检测到 2 组自交',
    };
    const before = { version: doc.editVersion, length: doc.history.length, position: doc.history.position };
    let lastCommand: CamCmd | null = null;
    const unsubscribe = onCam((command) => { lastCommand = command; });

    expect(focusSelfIntersectionEvidence(issue, 2)).toBe(true);
    expect(useCheck.getState().activeEvidenceIndex).toBe(0);
    expect(focusSelfIntersectionEvidence(issue, -1)).toBe(true);
    expect(useCheck.getState().activeEvidenceIndex).toBe(1);
    expect(lastCommand).toMatchObject({ kind: 'focusBounds' });
    expect({ version: doc.editVersion, length: doc.history.length, position: doc.history.position }).toEqual(before);
    unsubscribe();
  });
});
