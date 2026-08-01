import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreationAgentPanel } from '../src/agent/CreationAgentPanel';
import { GenPanel } from '../src/ai/GenPanel';

describe('M1.15a 创作入口 SSR', () => {
  it('呈现对话、Brief 与明确的权限边界', () => {
    const html = renderToString(<CreationAgentPanel />);
    expect(html).toContain('creation-agent-panel');
    expect(html).toContain('付费生成需点击确认');
    expect(html).toContain('理解参考图');
    expect(html).toContain('确认创作需求');
    expect(html).toContain('我想做一个原创角色手办');
  });

  it('快速图生模型入口不会重新露出旧文字直提交通道', () => {
    const html = renderToString(<GenPanel allowedTypes={['image', 'multiview']} />);
    expect(html).not.toContain('>文字<');
    expect(html).toContain('单图');
    expect(html).toContain('多图');
  });
});
