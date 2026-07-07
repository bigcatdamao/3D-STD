// T7 冒烟:TreePanel 在真实内核文档上可完整渲染(SSR,无浏览器)。
// 覆盖不到指针交互,只保证「渲染路径零运行时错误 + 关键信息落到 DOM」;交互按 README T7 验收手测。
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { TreePanel } from '../src/tree/TreePanel';
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

describe('TreePanel SSR 冒烟', () => {
  it('页签壳 + 树行 + 三状态列 + 空组空态可渲染', () => {
    const a = dispatch((d) => d.addAsset(asset('冒烟件')));
    const i1 = dispatch((d) => d.placeInstance(a.id));
    const i2 = dispatch((d) => d.placeInstance(a.id)); // 冒烟件 2(TREE-05 序号)
    dispatch((d) => d.group([i1.id], '外壳组'));
    dispatch((d) => d.setLocked([i2.id], true)); // 两种锁定字形都进 DOM

    const html = renderToString(<TreePanel />).replace(/<!-- -->/g, ''); // SSR 文本分段注释剥离
    expect(html).toContain('场景树');
    expect(html).toContain('资产');
    expect(html).toContain('外壳组');
    expect(html).toContain('冒烟件 2');
    expect(html).toContain('👁');
    expect(html).toContain('🔒');
    expect(html).toContain('🔓');
    expect(html).toContain('成组');
    expect(html).toContain('实例 2 · 组 1');
  });
});
