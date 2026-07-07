// T8 冒烟:ParamPanel 在真实内核文档上按三态上下文(PANEL-01)完整渲染(SSR,无浏览器)。
// 覆盖不到输入交互,只保证「渲染路径零运行时错误 + 关键信息落到 DOM」;交互按 README T8 验收手测。
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ParamPanel } from '../src/panel/ParamPanel';
import { doc, dispatch } from '../src/state/store';
import { Asset } from '../src/kernel/types';

const asset = (name: string): Omit<Asset, 'id'> => ({
  name,
  source: 'import',
  state: 'ready',
  meta: {
    faces: 128,
    bbox: { min: [0, 0, 0], max: [10, 10, 10] },
    unitChoice: 'mm',
    watertight: true,
    degenerate: false,
  },
});

const render = () => renderToString(<ParamPanel />).replace(/<!-- -->/g, '');

describe('ParamPanel SSR 冒烟(PANEL-01 三态)', () => {
  it('无选中 = 场景/打印床设置', () => {
    dispatch((d) => d.select([]));
    const html = render();
    expect(html).toContain('场景设置');
    expect(html).toContain('打印床');
    expect(html).toContain('256 × 256 × 256'); // VIEW-01 预设直达
  });

  it('单选 = 全属性:变换展开、材质/对象信息折叠(PANEL-02),数值 2 位小数(PANEL-05)', () => {
    const a = dispatch((d) => d.addAsset(asset('冒烟件')));
    const i = dispatch((d) => d.placeInstance(a.id));
    dispatch((d) => d.setTransformField(i.id, 'position', 0, 12.345));
    dispatch((d) => d.select([i.id]));

    const html = render();
    expect(html).toContain('变换');
    expect(html).toContain('位置 mm');
    expect(html).toContain('12.35'); // 显示 2 位小数,存储全精度
    expect(html).toContain('材质');
    expect(html).toContain('对象信息');
    expect(html).toContain('尺寸 mm'); // %↔mm 双显示(PANEL-04)
    expect(html).not.toContain('粗糙度'); // 折叠组内容默认不渲染(PANEL-02)
  });

  it('多选含锁定 = 混合占位「多值」+ 底部常驻跳过提示(PANEL-03/边界 1)', () => {
    const a = dispatch((d) => d.addAsset(asset('冒烟件')));
    const i1 = dispatch((d) => d.placeInstance(a.id));
    const i2 = dispatch((d) => d.placeInstance(a.id));
    const i3 = dispatch((d) => d.placeInstance(a.id));
    dispatch((d) => d.setTransformField(i2.id, 'rotation', 2, 30)); // 制造混合
    dispatch((d) => d.setLocked([i3.id], true));
    dispatch((d) => d.select([i1.id, i2.id, i3.id]));

    const html = render();
    expect(html).toContain('多值'); // 混合占位
    expect(html).toContain('编辑将跳过 1 个锁定对象'); // 边界 1 常驻提示
    expect(html).toContain('只读'); // 多选尺寸只读(PANEL-04)
  });
});
