import { describe, expect, it } from 'vitest';
import { SceneDocument } from '../src/kernel/scene';
import type { Asset } from '../src/kernel/types';
import { buildMockSplitAnalysis, buildSplitAnalysisContext } from '../src/agent/split-analysis-logic';
import type { CheckIssue } from '../src/check/check-core';

const bed = { x: 256, y: 256, z: 256 };

function asset(name: string, size: [number, number, number]): Omit<Asset, 'id'> {
  return {
    name,
    source: 'import',
    state: 'ready',
    meta: {
      faces: 120,
      bbox: { min: [0, 0, 0], max: size },
      unitChoice: 'mm',
      watertight: true,
      degenerate: false,
    },
  };
}

function contextFor(scene: SceneDocument, issues: CheckIssue[] = [], fresh = true) {
  return buildSplitAnalysisContext(scene, {
    goal: '适配打印空间并尽量隐藏接缝',
    priorities: ['fit_build_volume', 'preserve_strength'],
    process: 'fdm',
    bed,
    check: {
      phase: fresh ? 'done' : 'idle',
      stale: false,
      timedOut: false,
      unfinishedCount: 0,
      issues,
      summary: fresh
        ? { instances: 1, errors: issues.filter((issue) => issue.level === 'error').length, warnings: 0, totalFaces: 120, assetsAnalyzed: 1, assetsCached: 0, durationMs: 5 }
        : null,
    },
  });
}

describe('M1.6 拆件分析上下文与 Mock 结构化结果', () => {
  it('对象超过打印空间时建议拆件，并返回 2–3 套只读候选方案', () => {
    const scene = new SceneDocument();
    const source = scene.addAsset(asset('超长支架', [620, 80, 70]));
    scene.placeInstance(source.id);

    const context = contextFor(scene);
    const result = buildMockSplitAnalysis(context);

    expect(context.exceedsBuildVolume).toBe(true);
    expect(context.overflowAxes).toContain('X');
    expect(context.combinedDimensionsMm).toEqual([620, 80, 70]);
    expect(result.needsSplit).toBe('yes');
    expect(result.schemes.length).toBeGreaterThanOrEqual(2);
    expect(result.schemes.length).toBeLessThanOrEqual(3);
    expect(result.schemes.some((scheme) => scheme.recommended)).toBe(true);
    expect(result.recommendedRegions[0].description).toContain('不代表已计算出精确切割平面');
  });

  it('尺寸可放入且检查新鲜时优先保持整体打印', () => {
    const scene = new SceneDocument();
    const source = scene.addAsset(asset('小摆件', [80, 60, 100]));
    scene.placeInstance(source.id);

    const result = buildMockSplitAnalysis(contextFor(scene));
    expect(result.needsSplit).toBe('no');
    expect(result.recommendedPartCount.preferred).toBe(1);
    expect(result.schemes[0].title).toBe('保持整体打印');
  });

  it('非水密或退化网格不武断给切割结论，而是要求先修复', () => {
    const scene = new SceneDocument();
    const source = scene.addAsset(asset('开口盒', [80, 80, 80]));
    const instance = scene.placeInstance(source.id);
    const broken: CheckIssue = {
      key: `non_watertight:${instance.id}`,
      level: 'error',
      code: 'non_watertight',
      instanceId: instance.id,
      instanceName: instance.name,
      assetId: source.id,
      message: '非水密网格（4 条开放边界边）',
    };

    const result = buildMockSplitAnalysis(contextFor(scene, [broken]));
    expect(result.needsSplit).toBe('uncertain');
    expect(result.schemes[0].id).toBe('repair-first');
    expect(result.risks[0].severity).toBe('blocking');
    expect(result.nextSteps[0]).toContain('修复');
  });

  it('缺少打印检查时明确列入限制，不把薄壁和过悬当作已通过', () => {
    const scene = new SceneDocument();
    const source = scene.addAsset(asset('未知件', [90, 90, 90]));
    scene.placeInstance(source.id);

    const result = buildMockSplitAnalysis(contextFor(scene, [], false));
    expect(result.needsSplit).toBe('uncertain');
    expect(result.limitations.missingInputs).toContain('新鲜的打印检查结果');
    expect(result.limitations.unavailableCapabilities).toContain('薄壁分析');
    expect(result.limitations.unavailableCapabilities).toContain('局部过悬分析');
  });
});
