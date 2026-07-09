// T15 冒烟:ExportDialog 三阶段与顶栏 CTA 在真实内核文档上可完整 SSR 渲染。
// 覆盖不到点击交互(README T15 验收手测);断言渲染零错误 + 关键文案落 DOM:
// CHK-07 丢色说明、边界 3 置灰提示、CHK-08 错误列明与「仍要导出」。

import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ExportDialog, HeaderExportButton } from '../src/export/ExportDialog';
import { useExport } from '../src/export/export-state';
import { dispatch, doc } from '../src/state/store';
import type { Asset } from '../src/kernel/types';

const strip = (html: string) => html.replace(/<!-- -->/g, '');

describe('导出对话框 SSR(T15)', () => {
  it('空场景:顶栏 CTA 置灰并带提示(CHK 边界 3)', () => {
    // 本测试文件的 doc 从空开始(模块隔离),先断空态再造场景
    const html = strip(renderToString(<HeaderExportButton />));
    expect(html).toContain('disabled');
    expect(html).toContain('场景为空或全部隐藏');
  });

  it('有可见对象:CTA 可点,计数入提示', () => {
    const a = dispatch((d) =>
      d.addAsset({
        name: '样件',
        source: 'import',
        state: 'ready',
        meta: {
          faces: 12,
          bbox: { min: [-5, -5, -5], max: [5, 5, 5] },
          unitChoice: 'mm',
          watertight: true,
          degenerate: false,
        },
      } satisfies Omit<Asset, 'id'>),
    );
    dispatch((d) => d.placeInstance(a.id));
    const html = strip(renderToString(<HeaderExportButton />));
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('1 个可见对象');
  });

  it('options 阶段:范围/方式/丢色说明(CHK-07 文案)齐备;无选中时「仅选中」禁用', () => {
    dispatch((d) => d.select([]));
    useExport.setState({ open: true, stage: 'options', confirm: null });
    const html = strip(renderToString(<ExportDialog />));
    expect(html).toContain('全部可见对象');
    expect(html).toContain('仅选中对象(0 个)');
    expect(html).toContain('合并为单个 STL');
    expect(html).toContain('逐对象导出');
    expect(html).toContain('STL 不保留颜色与材质');
    expect(html).toContain('3MF');
    expect(html).toContain('Z-up · mm');
  });

  it('confirm 阶段:错误级/未检/排除项如实列明 +「仍要导出」(CHK-08/C4)', () => {
    const inst = [...doc.nodes.values()].find((n) => n.kind === 'instance')!;
    useExport.setState({
      open: true,
      stage: 'confirm',
      confirm: {
        errors: [
          {
            key: `non_watertight:${inst.id}`,
            level: 'error',
            code: 'non_watertight',
            instanceId: inst.id,
            instanceName: inst.name,
            assetId: 'x',
            message: '非水密:4 条边界边',
          },
        ],
        unfinished: ['超时件'],
        excluded: [{ name: '隐藏件', reason: '已隐藏(C7:隐藏不导出)' }],
      },
      pendingIds: [inst.id],
    });
    const html = strip(renderToString(<ExportDialog />));
    expect(html).toContain('错误级问题');
    expect(html).toContain('非水密:4 条边界边');
    expect(html).toContain('超时件');
    expect(html).toContain('隐藏件');
    expect(html).toContain('仍要导出');
    expect(html).toContain('不做拦截');
  });

  it('checking 阶段:进度条与 CHK-02 说明', () => {
    useExport.setState({ open: true, stage: 'checking', confirm: null });
    const html = strip(renderToString(<ExportDialog />));
    expect(html).toContain('导出前自动检查中');
  });

  it('关闭态:零输出', () => {
    useExport.setState({ open: false });
    expect(strip(renderToString(<ExportDialog />))).toBe('');
  });
});
