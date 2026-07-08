// T12 · GenPanel SSR 冒烟(node 环境:无 fetch 目标、无 storage、无 turnstile 脚本——全部安全空转)
// + visitor 自带 key 通道在无 storage 环境的回退语义。
// 全态交互(轮询/取消/三出路/刷新恢复)依赖运行时服务层,按 README「T12 验收」在部署环境点测。

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GenPanel } from '../src/ai/GenPanel';
import { turnstileSiteKey, usingTestSiteKey } from '../src/ai/turnstile';
import { apiHeaders, getEngineKey, setEngineKey } from '../src/net/visitor';

describe('GenPanel SSR', () => {
  it('初始渲染:输入区 + 提交键 + 图生占位,无运行时错误', () => {
    const html = renderToString(<GenPanel />);
    expect(html).toContain('gen-panel');
    expect(html).toContain('文生');
    expect(html).toContain('图生');
    expect(html).toContain('生成');
    expect(html.replace(/<!-- -->/g, '')).toContain('0/2000'); // 字数读数(AI-01 上限可见;SSR 文本节点间有注释分隔)
  });
});

describe('Turnstile site key 决议', () => {
  it('构建变量缺位时回退官方测试 key(与测试 secret 配对,零配置可走通)', () => {
    expect(turnstileSiteKey().length).toBeGreaterThan(10);
    // node 测试环境无 VITE_TURNSTILE_SITE_KEY,应回退
    expect(usingTestSiteKey()).toBe(true);
  });
});

describe('自带 key 通道(D6 ④)在无 storage 环境的回退', () => {
  it('读写安全空转,apiHeaders 不携带 x-engine-key', () => {
    setEngineKey('tcli_test'); // 无 sessionStorage:静默失败
    expect(getEngineKey()).toBeNull();
    expect(apiHeaders()['x-engine-key']).toBeUndefined();
  });
});
