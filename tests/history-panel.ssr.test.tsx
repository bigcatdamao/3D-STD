// T9 冒烟:HistoryPanel 在真实内核文档上可完整渲染(SSR,无浏览器)。
// 覆盖不到点击/hover 交互,只保证「渲染路径零运行时错误 + 关键信息落到 DOM」;交互按 README T9 验收手测。
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { HistoryPanel } from '../src/history/HistoryPanel';
import { doc, dispatch } from '../src/state/store';
import { Asset } from '../src/kernel/types';

const asset = (name: string): Omit<Asset, 'id'> => ({
  name,
  source: 'import',
  state: 'ready',
  meta: {
    faces: 12,
    bbox: { min: [0, 0, 0], max: [10, 10, 10] },
    unitChoice: 'mm',
    watertight: true,
    degenerate: false,
  },
});

const strip = (html: string) => html.replace(/<!-- -->/g, '');

describe('HistoryPanel SSR 冒烟', () => {
  it('空栈空态 → 条目/位置/图标/目标名 → 撤销后 redo 侧仍在列表', () => {
    let html = strip(renderToString(<HistoryPanel />));
    expect(html).toContain('暂无历史');
    expect(html).toContain('◦ 初始');

    const a = dispatch((d) => d.addAsset(asset('冒烟件')));
    const i = dispatch((d) => d.placeInstance(a.id));
    dispatch((d) => d.rename(i.id, '底座'));
    dispatch((d) => d.setLocked([i.id], true));

    html = strip(renderToString(<HistoryPanel />));
    expect(html).toContain('3/3'); // 当前位置指示(HIST-04)
    expect(html).toContain('导入');
    expect(html).toContain('重命名 · 底座');
    expect(html).toContain('锁定');
    expect(html).toContain('📥'); // HIST-07 图标
    expect(html).toContain('🔒');
    expect(html).toContain('冒烟件'); // 目标名列(入栈时刻快照:导入时还叫冒烟件)

    dispatch((d) => d.history.undo());
    html = strip(renderToString(<HistoryPanel />));
    expect(html).toContain('2/3'); // 撤销后条目不消失,cursor 左移(线性栈可视化)
  });

  it('冻结呈现(HIST 边界 1):灰态可见 + 角标;解冻恢复', () => {
    dispatch((d) => d.history.setFrozen(true));
    let html = strip(renderToString(<HistoryPanel />));
    expect(html).toContain('预览态 · 历史冻结');
    expect(html).toContain('opacity:0.55'); // 面板整体灰态,列表仍可见
    dispatch((d) => d.history.setFrozen(false));
    html = strip(renderToString(<HistoryPanel />));
    expect(html).not.toContain('预览态 · 历史冻结');
  });

  it('栈满溢出(HIST 边界 5):时间轴最左出现「更早的记录已合并」占位', () => {
    const a = dispatch((d) => d.addAsset(asset('批量件')));
    // cap 默认 50;当前已有 3 条,再压 60 条独立记录触发丢弃
    for (let k = 0; k < 60; k++) {
      const inst = dispatch((d) => d.placeInstance(a.id));
      dispatch((d) => d.removeNodes([inst.id]));
    }
    expect(doc.history.hasOverflowed).toBe(true);
    const html = strip(renderToString(<HistoryPanel />));
    expect(html).toContain('更早的记录已合并');
    expect(html).toContain('50/50');
  });
});
