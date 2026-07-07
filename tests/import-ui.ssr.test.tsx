// T10 冒烟:导入状态条与单位确认对话框的 SSR 渲染(无浏览器)。
// 只保证「渲染路径零运行时错误 + 关键信息落到 DOM」;拖放/进度/取消交互按 README T10 验收手测。
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ImportStatusStrip, UnitDialog, DragHighlight } from '../src/importer/ImportUI';
import { useUi } from '../src/state/store';

const render = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, '');

describe('ImportStatusStrip(IMP-08)', () => {
  it('空列表不渲染', () => {
    useUi.setState({ importJobs: [] });
    expect(render(<ImportStatusStrip />)).toBe('');
  });

  it('解析中占位:名称 + 阶段 + 进度可见;可取消', () => {
    useUi.setState({
      importJobs: [
        { id: 'j1', name: 'bracket.stl', phase: 'running', pct: 58, phaseText: '焊接顶点' },
      ],
    });
    const html = render(<ImportStatusStrip />);
    expect(html).toContain('bracket.stl');
    expect(html).toContain('焊接顶点');
    expect(html).toContain('width:58%');
    expect(html).toContain('✕');
  });

  it('失败态:分类文案常驻,可重试项出「重试」,不可重试只有「移除」', () => {
    useUi.setState({
      importJobs: [
        {
          id: 'j2',
          name: 'broken.stl',
          phase: 'failed',
          pct: 0,
          phaseText: '失败',
          error: { code: 'corrupt', message: '无法解析为有效的 STL 文件', retryable: true },
        },
        {
          id: 'j3',
          name: 'model.fbx',
          phase: 'failed',
          pct: 0,
          phaseText: '失败',
          error: { code: 'rejected-fbx', message: '暂不支持 FBX,请从建模软件导出为 GLB 或 STL', retryable: false },
        },
      ],
    });
    const html = render(<ImportStatusStrip />);
    expect(html).toContain('无法解析为有效的 STL 文件');
    expect(html).toContain('暂不支持 FBX');
    expect(html.match(/重试/g)?.length).toBe(1); // 仅可重试项
    expect(html.match(/移除/g)?.length).toBe(2);
  });
});

describe('UnitDialog(IMP-05)', () => {
  it('未询问时不渲染', () => {
    useUi.setState({ unitAsk: null });
    expect(render(<UnitDialog />)).toBe('');
  });

  it('四单位选项 + 推荐标注 + 各单位落床尺寸换算 + 超床 C4 提示', () => {
    useUi.setState({
      unitAsk: {
        jobId: 'j9',
        name: '巨型件',
        bboxRaw: { min: [0, 0, 0], max: [0.5, 0.3, 0.2] }, // 米级建模
        unit: 'm',
        recommended: 'm',
        slotX: 0,
      },
    });
    const html = render(<UnitDialog />);
    expect(html).toContain('确认「巨型件」的单位');
    for (const label of ['毫米 mm', '厘米 cm', '英寸 inch', '米 m']) expect(html).toContain(label);
    expect(html).toContain('·推荐');
    expect(html).toContain('500 × 300 × 200 mm'); // m 行换算
    expect(html).toContain('12.7 × 7.6'); // inch 行换算(0.5×25.4)
    expect(html).toContain('仍可导入'); // 超床提示只提示不拦截(C4)
    expect(html).toContain('确认导入');
    expect(html).toContain('取消导入');
    useUi.setState({ unitAsk: null });
  });
});

describe('DragHighlight', () => {
  it('拖入时提示支持格式', () => {
    useUi.setState({ dragImport: true });
    expect(render(<DragHighlight />)).toContain('GLB / glTF / STL / OBJ');
    useUi.setState({ dragImport: false });
  });
});
