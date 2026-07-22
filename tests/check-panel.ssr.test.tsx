// T14 冒烟:CheckPanel 在真实内核文档 + 注入报告上可完整渲染(SSR,无浏览器/无 Worker)。
// 覆盖不到点击/聚焦交互,只保证「渲染路径零运行时错误 + 关键信息落到 DOM」;交互按 README T14 验收手测。

import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CheckPanel } from '../src/check/CheckPanel';
import { useCheck } from '../src/check/check-state';
import { dispatch, doc, useUi } from '../src/state/store';
import type { Asset } from '../src/kernel/types';
import type { CheckIssue, CheckSummary } from '../src/check/check-core';
import { useMeshRepair } from '../src/repair/mesh-repair-state';

const strip = (html: string) => html.replace(/<!-- -->/g, '');

const asset = (name: string): Omit<Asset, 'id'> => ({
  name,
  source: 'import',
  state: 'ready',
  meta: {
    faces: 10,
    bbox: { min: [-12, -12, -8], max: [12, 12, 8] },
    unitChoice: 'mm',
    watertight: false,
    degenerate: false,
  },
});

const summary: CheckSummary = {
  instances: 2,
  errors: 1,
  warnings: 1,
  totalFaces: 20,
  assetsAnalyzed: 1,
  assetsCached: 1,
  durationMs: 12,
};

function issuesFor(id: string, name: string): CheckIssue[] {
  return [
    {
      key: `non_watertight:${id}`,
      level: 'error',
      code: 'non_watertight',
      instanceId: id,
      instanceName: name,
      assetId: 'a1',
      message: '非水密网格(4 条开放边界边)。可先生成安全修复预览；复杂破损仍需外部网格工具',
    },
    {
      key: `floating:${id}`,
      level: 'warning',
      code: 'floating',
      instanceId: id,
      instanceName: name,
      assetId: 'a1',
      message: '悬空 6.0mm(底面未接触打印床)',
      world: { min: [58, -72, 6], max: [82, -48, 22] },
      fix: { kind: 'drop', zMin: 6 },
    },
    {
      key: `dims:${id}`,
      level: 'info',
      code: 'dims',
      instanceId: id,
      instanceName: name,
      assetId: 'a1',
      message: '24.0 × 24.0 × 16.0 mm · 10 面',
    },
  ];
}

describe('CheckPanel SSR 冒烟', () => {
  it('空闲空态 → 展开引导文案', () => {
    useCheck.setState({ panelOpen: true, phase: 'idle' });
    const html = strip(renderToString(<CheckPanel />));
    expect(html).toContain('打印检查');
    expect(html).toContain('未检查');
    expect(html).toContain('尚未检查');
  });

  it('新鲜报告:分级列表 + 修复按钮 + 汇总行(CHK-05/CHK-04 口径)', () => {
    useMeshRepair.setState({ phase: 'idle' });
    const a = dispatch((d) => d.addAsset(asset('开口盒')));
    const i = dispatch((d) => d.placeInstance(a.id, '导入', 'place', [70, -60, 14]));
    useCheck.setState({
      panelOpen: true,
      phase: 'done',
      issues: issuesFor(i.id, '开口盒'),
      summary,
      unfinished: [],
      timedOut: false,
      fixedKeys: [],
      runMeta: { editVersion: doc.editVersion, bed: { ...useUi.getState().bed } },
    });
    const html = strip(renderToString(<CheckPanel />));
    expect(html).toContain('1 错误 · 1 警告'); // 状态一目了然
    expect(html).toContain('错误(1)');
    expect(html).toContain('警告(1)');
    expect(html).toContain('信息(1)');
    expect(html).toContain('非水密网格');
    expect(html).toContain('安全修复预览');
    expect(html).toContain('修复预览');
    expect(html).toContain('⬇ 沉底'); // 悬空修复按钮
    expect(html).toContain('投影落点'); // CHK-05 悬空示投影距离
    expect(html).toContain('几何分析 1 次 · 缓存复用 1 次'); // CHK-04 可观测口径
  });

  it('修复预览卡明确显示前后指标、原模型不变和确认动作', () => {
    useMeshRepair.setState({
      phase: 'ready',
      sourceName: '开口盒',
      instanceId: null,
      sourceAssetId: null,
      actions: ['封闭 1 个平面边界环，新增 2 个面'],
      warnings: ['开口可能是设计意图'],
      reason: null,
      stats: {
        before: { faces: 10, weldedVertices: 8, degenerateCount: 0, boundaryEdges: 4, nonManifoldEdges: 0, watertight: false },
        after: { faces: 12, weldedVertices: 8, degenerateCount: 0, boundaryEdges: 0, nonManifoldEdges: 0, watertight: true },
        sourceVertices: 30,
        weldedVertices: 8,
        removedDegenerateFaces: 0,
        removedDuplicateFaces: 0,
        filledHoles: 1,
        addedFaces: 2,
      },
    });
    const html = strip(renderToString(<CheckPanel />));
    expect(html).toContain('网格修复预览');
    expect(html).toContain('原模型不变');
    expect(html).toContain('开放边');
    expect(html).toContain('生成修复副本');
    expect(html).toContain('修复后叠加');
    expect(html).toContain('仅看变化');
    expect(html).toContain('绿色：新增面');
    expect(html).toContain('红色：删除面');
    useMeshRepair.setState({ phase: 'idle' });
  });

  it('复杂拓扑问题显示只读诊断与自交证据浏览，不提供自动修复按钮', () => {
    const instance = [...doc.nodes.values()].find((node) => node.kind === 'instance')!;
    const assetId = instance.kind === 'instance' ? instance.assetId : '';
    useCheck.setState({
      panelOpen: true,
      phase: 'done',
      issues: [
        {
          key: `self_intersection:${instance.id}`,
          level: 'error',
          code: 'self_intersection',
          instanceId: instance.id,
          instanceName: instance.name,
          assetId,
          message: '检测到 1 组不相邻面片相交',
        },
        {
          key: `internal_shell:${instance.id}`,
          level: 'warning',
          code: 'internal_shell',
          instanceId: instance.id,
          instanceName: instance.name,
          assetId,
          message: '疑似包含 1 个内部封闭壳体',
        },
      ],
      assetMetas: [{
        assetId,
        faces: 10,
        weldedVertices: 8,
        degenerateCount: 0,
        boundaryEdges: 0,
        nonManifoldEdges: 0,
        watertight: true,
        health: {
          connectedComponents: 1,
          closedComponents: 1,
          componentAnalysisComplete: true,
          isolatedFragments: 0,
          isolatedFragmentFaces: 0,
          internalShells: 0,
          selfIntersectionPairs: 1,
          selfIntersectionComplete: true,
          selfIntersectionTrianglesScanned: 10,
          selfIntersectionPairTests: 2,
          selfIntersectionEvidence: [{
            faceA: 2,
            faceB: 9,
            triangleA: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            triangleB: [[0, 0, -1], [0, 0, 1], [1, 0, 0]],
          }],
        },
        analysisMs: 1,
        cached: false,
      }],
      activeKey: `self_intersection:${instance.id}`,
      activeEvidenceIndex: 0,
      summary: { ...summary, errors: 1, warnings: 1, instances: 1 },
      unfinished: [],
      timedOut: false,
      fixedKeys: [],
      runMeta: { editVersion: doc.editVersion, bed: { ...useUi.getState().bed } },
    });
    const html = strip(renderToString(<CheckPanel />));
    expect(html).toContain('只读诊断');
    expect(html).toContain('内部封闭壳体');
    expect(html).toContain('证据 1/1');
    expect(html).toContain('面 #2 × #9');
    expect(html).toContain('定位');
    expect(html).not.toContain('修复预览');
  });

  it('过期(CHK-03):灰显条 + 重新检查;修复按钮禁用理由', () => {
    // 上一用例已注入报告;此处制造一次编辑令其过期
    dispatch((d) => {
      const anyInst = [...d.nodes.values()].find((n) => n.kind === 'instance')!;
      d.rename(anyInst.id, '开口盒·改名');
    });
    const html = strip(renderToString(<CheckPanel />));
    expect(html).toContain('结果已过期');
    expect(html).toContain('重新检查');
  });

  it('对象删除(边界 2):条目随对象失效移除', () => {
    const victims = [...doc.nodes.values()].filter((n) => n.kind === 'instance').map((n) => n.id);
    dispatch((d) => d.removeNodes(victims));
    const html = strip(renderToString(<CheckPanel />));
    expect(html).not.toContain('非水密网格'); // 条目消失
  });

  it('超时呈现(CHK-02):未完成清单 + 分对象重试按钮', () => {
    useCheck.setState({
      panelOpen: true,
      phase: 'done',
      issues: [],
      summary: { ...summary, instances: 3 },
      unfinished: [
        { id: 'x1', name: '大件A' },
        { id: 'x2', name: '大件B' },
      ],
      timedOut: true,
      runMeta: { editVersion: doc.editVersion, bed: { ...useUi.getState().bed } },
    });
    const html = strip(renderToString(<CheckPanel />));
    expect(html).toContain('未完成 2 件');
    expect(html).toContain('大件A');
    expect(html).toContain('重试未完成');
  });

  it('已执行修复标记 + 通过态', () => {
    const a = dispatch((d) => d.addAsset({ ...asset('好件'), meta: { ...asset('好件').meta, watertight: true } }));
    const i = dispatch((d) => d.placeInstance(a.id));
    useCheck.setState({
      panelOpen: true,
      phase: 'done',
      issues: [
        {
          key: `dims:${i.id}`,
          level: 'info',
          code: 'dims',
          instanceId: i.id,
          instanceName: '好件',
          assetId: a.id,
          message: '20.0 × 20.0 × 20.0 mm · 12 面',
        },
      ],
      summary: { ...summary, errors: 0, warnings: 0, instances: 1 },
      unfinished: [],
      timedOut: false,
      fixedKeys: [`dims:${i.id}`],
      runMeta: { editVersion: doc.editVersion, bed: { ...useUi.getState().bed } },
    });
    const html = strip(renderToString(<CheckPanel />));
    expect(html).toContain('✓ 通过');
    expect(html).toContain('已执行修复');
  });
});
