import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoSplitPanel } from '../src/split/AutoSplitPanel';
import { useAutoSplit } from '../src/split/auto-split-state';

describe('M1.13b 自动拆件面板', () => {
  afterEach(() => useAutoSplit.setState({ phase: 'idle', instanceId: null, sourceAssetId: null }));

  it('提交前把费用、外部处理、原资产保留和粒度讲清楚', () => {
    useAutoSplit.setState({
      phase: 'ready',
      sourceName: '机甲测试件',
      sourceFaces: 646_976,
      uploadBytes: 32 * 1024 * 1024,
      level: 'medium',
      error: null,
    });
    const html = renderToString(<AutoSplitPanel />);
    expect(html).toContain('机甲测试件');
    expect(html).toContain('20');
    expect(html).toContain('Hi3D');
    expect(html).toContain('源资产保留');
    expect(html).toContain('标准');
    expect(html).toContain('等待验证');
  });
});
