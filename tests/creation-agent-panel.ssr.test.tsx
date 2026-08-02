import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreationAgentPanel } from '../src/agent/CreationAgentPanel';
import { GenPanel } from '../src/ai/GenPanel';
import { CreationPanel } from '../src/App';

describe('M1.16b 对话优先创作工作台 SSR', () => {
  it('在同一个三栏骨架中呈现对话、四阶段与 Brief', () => {
    const html = renderToString(<CreationAgentPanel />);
    expect(html).toContain('creation-agent-panel');
    expect(html).toContain('creation-agent__conversation');
    expect(html).toContain('creation-agent__stage');
    expect(html).toContain('creation-agent__brief');
    expect(html).toContain('需求确认');
    expect(html).toContain('视觉方案');
    expect(html).toContain('效果图');
    expect(html).toContain('3D 成模');
    expect(html).toContain('付费生成需点击确认');
    expect(html).toContain('理解参考图');
    expect(html).toContain('确认 Brief 并生成视觉方案');
    expect(html).toContain('我想做一个原创角色手办');
  });

  it('Agent 内嵌 Hi3D 入口只保留单图和多图模式', () => {
    const html = renderToString(<GenPanel allowedTypes={['image', 'multiview']} />);
    expect(html).not.toContain('>文字<');
    expect(html).toContain('单图');
    expect(html).toContain('多图');
  });

  it('M1.17a.2 提供已有图片直接成模的固定入口', () => {
    const html = renderToString(<CreationPanel dismissible={false} onClose={() => undefined} initialRoute="image" />);
    expect(html).toContain('已有图片，直接生成 3D 模型');
    expect(html).toContain('已有图片成模');
    expect(html).toContain('跳过需求对话和效果图生成');
    expect(html).toContain('点击或拖入主体图片');
    expect(html).toContain('单图');
    expect(html).toContain('多图');
    expect(html).not.toContain('creation-agent__conversation');
  });
});
