import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualPlaneSplitPanel } from '../src/split/ManualPlaneSplitPanel';
import {
  cancelManualPlaneSplit,
  useManualPlaneSplit,
} from '../src/split/manual-plane-split-state';

afterEach(cancelManualPlaneSplit);

describe('ManualPlaneSplitPanel SSR', () => {
  it('exposes axis presets, transform fields, safety boundary, and confirm action', () => {
    useManualPlaneSplit.setState({
      phase: 'editing',
      instanceId: 'missing',
      sourceAssetId: 'missing',
      sourceEditVersion: -1,
      position: [10, 20, 30],
      rotation: [0, 0, 0],
      size: [120, 140],
      bounds: { min: [0, 0, 0], max: [40, 50, 60] },
      mode: 'translate',
      axis: 'z',
      progress: '',
      error: null,
      errorCode: null,
      durationMs: null,
    }, true);
    const html = renderToStaticMarkup(<ManualPlaneSplitPanel />);

    expect(html).toContain('真实几何操作');
    expect(html).toContain('平面切割');
    expect(html).toContain('源模型保持不变');
    expect(html).toContain('切割轴');
    expect(html).toContain('切割框大小');
    expect(html).toContain('实际切割按无限平面计算');
    expect(html).toContain('确认切割');
    expect(html).toContain('W');
    expect(html).toContain('E');
    expect(html).toContain('R');
  });
});
