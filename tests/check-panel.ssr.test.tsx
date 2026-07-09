// T14 冒烟:CheckPanel 在真实内核文档 + 注入报告上可完整渲染(SSR,无浏览器/无 Worker)。
// 覆盖不到点击/聚焦交互,只保证「渲染路径零运行时错误 + 关键信息落到 DOM」;交互按 README T14 验收手测。

import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CheckPanel } from '../src/check/CheckPanel';
import { useCheck } from '../src/check/check-state';
import { dispatch, doc, useUi } from '../src/state/store';
import type { Asset } from '../src/kernel/types';
import type { CheckIssue, CheckSummary } from '../src/check/check-core';

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
      message: '非水密网格(4 条开放边界边)。本产品不做网格补洞,导出后请在切片软件中修复',
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
    expect(html).toContain('切片软件'); // Non-goal 引导(CHK-06)
    expect(html).toContain('⬇ 沉底'); // 悬空修复按钮
    expect(html).toContain('投影落点'); // CHK-05 悬空示投影距离
    expect(html).toContain('几何分析 1 次 · 缓存复用 1 次'); // CHK-04 可观测口径
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
