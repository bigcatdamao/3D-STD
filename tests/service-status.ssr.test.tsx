// T3 冒烟:访客工具在无 storage 环境的回退语义 + 顶栏 ServiceStatus SSR 渲染零错误。
// 真实的配额显示与诊断演练依赖运行时 fetch,按 README「T3 验收」在部署环境点测。
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ServiceStatus } from '../src/net/ServiceStatus';
import { apiHeaders, captureDemoCode, getClientId } from '../src/net/visitor';

describe('visitor 工具(node 环境 = 无 localStorage,走回退)', () => {
  it('clientId 会话内稳定', () => {
    const a = getClientId();
    const b = getClientId();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });

  it('apiHeaders 至少携带 x-client-id', () => {
    const h = apiHeaders();
    expect(h['x-client-id']).toBe(getClientId());
  });

  it('captureDemoCode 在无 storage 环境安全返回 null', () => {
    expect(captureDemoCode('?demo=abc')).toBeNull();
  });
});

describe('ServiceStatus SSR', () => {
  it('初始渲染含服务层芯片,无运行时错误', () => {
    const html = renderToString(<ServiceStatus />);
    expect(html).toContain('服务层');
    expect(html).toContain('检测中');
  });
});
