import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  assessConnectorPairCandidate,
  buildConnectorPair,
  faceCountOf,
  type ConnectorCandidate,
} from '../src/connector/connector-geometry.js';
import { defaultTransform } from '../src/kernel/types.js';

describe('M1.18 圆柱连接真实布尔', () => {
  it('相接的两个封闭方块生成凸榫与配对圆孔，且不改写源几何', () => {
    const first = new THREE.BoxGeometry(44, 44, 44);
    const second = new THREE.BoxGeometry(44, 44, 44);
    const firstFaces = faceCountOf(first);
    const secondFaces = faceCountOf(second);
    const result = buildConnectorPair({
      first: {
        geometry: first,
        transform: { ...defaultTransform(), position: [-22, 0, 22] },
        point: [0, 0, 22],
        normal: [1, 0, 0],
      },
      second: {
        geometry: second,
        transform: { ...defaultTransform(), position: [22, 0, 22] },
        point: [0, 0, 22],
        normal: [-1, 0, 0],
      },
      firstRole: 'male',
      parameters: { diameterMm: 4, depthMm: 7, clearanceMm: 0.25 },
    });
    expect(result.first.boundingBox!.max.x).toBeGreaterThan(22);
    expect(result.second.boundingBox!.min.x).toBeCloseTo(-22, 2);
    expect(faceCountOf(result.first)).toBeGreaterThan(firstFaces);
    expect(faceCountOf(result.second)).toBeGreaterThan(secondFaces);
    expect(faceCountOf(first)).toBe(firstFaces);
    expect(faceCountOf(second)).toBe(secondFaces);
    result.first.dispose();
    result.second.dispose();
    first.dispose();
    second.dispose();
  });

  it('交换第一件角色时，凸榫随角色转移', () => {
    const result = buildConnectorPair({
      first: {
        geometry: new THREE.BoxGeometry(30, 30, 30),
        transform: { ...defaultTransform(), position: [-15, 0, 15] },
        point: [0, 0, 15],
        normal: [1, 0, 0],
      },
      second: {
        geometry: new THREE.BoxGeometry(30, 30, 30),
        transform: { ...defaultTransform(), position: [15, 0, 15] },
        point: [0, 0, 15],
        normal: [-1, 0, 0],
      },
      firstRole: 'female',
      parameters: { diameterMm: 3, depthMm: 5, clearanceMm: 0.2 },
    });
    expect(result.second.boundingBox!.min.x).toBeLessThan(-15);
    result.first.dispose();
    result.second.dispose();
  });

  it('阻止距离过远或表面不相向的假配对，只放行同一接缝两侧', () => {
    const first: ConnectorCandidate = {
      instanceId: 'a', point: [0, 0, 0], normal: [1, 0, 0], faceIndex: 0,
      faceAreaMm2: 20, estimatedDepthMm: 20, recommendedMaxDiameterMm: 8,
      rating: 'good', message: 'ok',
    };
    const candidate = (point: [number, number, number], normal: [number, number, number]): ConnectorCandidate => ({
      ...first, instanceId: 'b', point, normal,
    });
    const parameters = { diameterMm: 4, depthMm: 7, clearanceMm: 0.25 };
    expect(assessConnectorPairCandidate(first, candidate([30, 0, 0], [-1, 0, 0]), parameters).rating).toBe('invalid');
    expect(assessConnectorPairCandidate(first, candidate([0, 0, 0], [1, 0, 0]), parameters).rating).toBe('invalid');
    expect(assessConnectorPairCandidate(first, candidate([0.4, 0, 0], [-1, 0, 0]), parameters).rating).toBe('good');
  });
});
