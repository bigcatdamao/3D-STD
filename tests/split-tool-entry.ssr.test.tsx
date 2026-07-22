import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Toolbar } from '../src/viewport/Viewport';

describe('M1.7.9 主动拆件入口', () => {
  it('画布工具栏固定显示明确的拆件按钮', () => {
    const html = renderToString(<Toolbar onOpenSplit={() => {}} />);
    expect(html).toContain('data-testid="split-tool-entry"');
    expect(html).toContain('✂ 拆件');
    expect(html).toContain('先选中一个对象，再打开拆件工作台');
    expect(html).not.toContain('AI 拆件');
  });
});
