import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoSplitPanel } from '../src/split/AutoSplitPanel';
import { useAutoSplit } from '../src/split/auto-split-state';

describe('M1.17a.2 混元自动拆件面板', () => {
  afterEach(() => useAutoSplit.setState({ phase: 'idle', instanceId: null, sourceAssetId: null }));

  it('提交前把费用、FBX 来源和原资产保留讲清楚', () => {
    useAutoSplit.setState({
      phase: 'ready',
      sourceName: '机甲测试件',
      sourceFaces: 646_976,
      uploadBytes: 0,
      level: 'medium',
      error: null,
      sourceMode: 'provider-fbx',
      sourceProvider: 'hunyuan',
      sourceProviderTaskId: 'hy3d_model_1',
    });
    const html = renderToString(<AutoSplitPanel />);
    expect(html).toContain('机甲测试件');
    expect(html).toContain('30');
    expect(html).toContain('混元');
    expect(html).toContain('FBX');
    expect(html).toContain('源资产保留');
    expect(html).toContain('等待验证');
  });
});
