import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { analyzePlaneSection } from '../src/split/plane-section-core';

const identity = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

function inputOf(geometry: THREE.BufferGeometry) {
  return {
    positions: geometry.getAttribute('position').array,
    index: geometry.index?.array ?? null,
    transform: identity,
  };
}

describe('M1.7.6 真实平面截面分析', () => {
  it('完整扫描封闭盒时生成闭合轮廓、真实面积和周长', () => {
    const geometry = new THREE.BoxGeometry(300, 80, 80).translate(0, 0, 40);
    const result = analyzePlaneSection({
      ...inputOf(geometry),
      axisIndex: 0,
      positionMm: 0,
    });
    expect(result.status).toBe('closed');
    expect(result.complete).toBe(true);
    expect(result.loopCount).toBe(1);
    expect(result.openChainCount).toBe(0);
    expect(result.areaMm2).toBeCloseTo(6_400, 4);
    expect(result.perimeterMm).toBeCloseTo(320, 4);
    expect(result.segmentCount).toBeGreaterThanOrEqual(4);
    geometry.dispose();
  });

  it('非水密单三角形只返回开链证据，不伪造面积', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -10, -10, 0,
      10, -10, 0,
      0, 10, 0,
    ], 3));
    const result = analyzePlaneSection({
      ...inputOf(geometry),
      axisIndex: 0,
      positionMm: 0,
    });
    expect(result.status).toBe('open');
    expect(result.segmentCount).toBe(1);
    expect(result.openChainCount).toBe(1);
    expect(result.areaMm2).toBeNull();
    geometry.dispose();
  });

  it('按实例世界变换分析切面', () => {
    const geometry = new THREE.BoxGeometry(20, 10, 6);
    const result = analyzePlaneSection({
      ...inputOf(geometry),
      transform: {
        position: [25, 0, 3],
        rotation: [0, 0, 0],
        scale: [2, 3, 1],
      },
      axisIndex: 0,
      positionMm: 25,
    });
    expect(result.status).toBe('closed');
    expect(result.areaMm2).toBeCloseTo(180, 4);
    expect(result.perimeterMm).toBeCloseTo(72, 4);
    geometry.dispose();
  });

  it('扫描预算不足时只返回部分线段，不输出闭合或面积结论', () => {
    const geometry = new THREE.BoxGeometry(300, 80, 80).translate(0, 0, 40);
    const result = analyzePlaneSection({
      ...inputOf(geometry),
      axisIndex: 0,
      positionMm: 0,
      faceBudget: 2,
    });
    expect(result.status).toBe('partial');
    expect(result.complete).toBe(false);
    expect(result.facesTested).toBe(2);
    expect(result.facesTotal).toBe(12);
    expect(result.areaMm2).toBeNull();
    expect(result.warnings[0]).toContain('仅分析 2 / 12 面');
    geometry.dispose();
  });

  it('平面未形成有效截线时返回 empty', () => {
    const geometry = new THREE.BoxGeometry(20, 10, 6);
    const result = analyzePlaneSection({
      ...inputOf(geometry),
      axisIndex: 0,
      positionMm: 100,
    });
    expect(result.status).toBe('empty');
    expect(result.segmentCount).toBe(0);
    expect(result.areaMm2).toBeNull();
    geometry.dispose();
  });
});
