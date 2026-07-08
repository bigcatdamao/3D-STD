// T11 冒烟:AssetPanel 在真实内核文档上可完整渲染(SSR,无浏览器)。
// 覆盖不到拖放/IndexedDB,只保证「渲染路径零运行时错误 + 关键信息落到 DOM」;
// 拖放、持久化与容量交互按 README T11 验收手测 + persist.test 逻辑覆盖。
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetPanel } from '../src/assets/AssetPanel';
import { Asset } from '../src/kernel/types';
import { dispatch, doc, geometryRegistry, thumbRegistry, useUi } from '../src/state/store';

const asset = (name: string, over: Partial<Asset> = {}): Omit<Asset, 'id'> => ({
  name,
  source: 'import',
  state: 'ready',
  meta: {
    faces: 4096,
    bbox: { min: [0, 0, 0], max: [10, 10, 10] },
    unitChoice: 'mm',
    watertight: true,
    degenerate: false,
    createdAt: Date.now(),
  },
  ...over,
});

afterEach(() => {
  for (const id of [...doc.assets.keys()]) {
    doc.assets.delete(id);
    thumbRegistry.delete(id);
    geometryRegistry.delete(id);
  }
  useUi.setState({
    importJobs: [],
    storage: { mode: 'init', usedBytes: 0, capBytes: 500 * 1024 * 1024, unsavedIds: [] },
  });
});

describe('AssetPanel SSR 冒烟', () => {
  it('网格条目 + 来源/状态角标 + 解析条目 + 容量条可渲染', () => {
    const a = dispatch((d) => d.addAsset(asset('冒烟资产')));
    thumbRegistry.set(a.id, 'data:image/png;base64,x');
    dispatch((d) => d.addAsset(asset('AI 冒烟', { source: 'ai', state: 'expired' })));
    useUi.setState({
      importJobs: [
        { id: 'imp_x', name: '解析中.stl', phase: 'running', pct: 55, phaseText: '解析几何' },
        {
          id: 'imp_y',
          name: '坏件.glb',
          phase: 'failed',
          pct: 0,
          phaseText: '失败',
          error: { code: 'corrupt', message: '无法解析为有效的 GLB 文件', retryable: true },
        },
      ],
      storage: { mode: 'idb', usedBytes: 420 * 1024 * 1024, capBytes: 500 * 1024 * 1024, unsavedIds: [a.id] },
    });

    const html = renderToString(<AssetPanel />).replace(/<!-- -->/g, '');
    expect(html).toContain('冒烟资产');
    expect(html).toContain('4,096 面');
    expect(html).toContain('AI'); // 来源角标
    expect(html).toContain('已失效'); // 状态机角标
    expect(html).toContain('解析中.stl');
    expect(html).toContain('无法解析为有效的 GLB 文件');
    expect(html).toContain('本地存储');
    expect(html).toContain('420.0 MB');
    expect(html).toContain('自动补存'); // 未保存引导(AST-04)
    expect(html).toContain('导入'); // 仅入库入口
  });

  it('会话模式常驻提示(AST 边界 1)与空库空态', () => {
    useUi.setState({ storage: { mode: 'session', usedBytes: 0, capBytes: 0, unsavedIds: [] } });
    const html = renderToString(<AssetPanel />).replace(/<!-- -->/g, '');
    expect(html).toContain('本次会话的资产不会被保存');
    expect(html).toContain('资产库为空');
    expect(html).not.toContain('本地存储'); // 会话模式无容量条
  });
});
