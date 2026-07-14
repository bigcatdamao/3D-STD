import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
} from '../src/product/workspace-layout';

describe('M1.5 工作台布局偏好', () => {
  it('无记录或损坏记录回退到产品默认值', () => {
    expect(parseWorkspaceLayout(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(parseWorkspaceLayout('{bad json')).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('逐项接收合法偏好并忽略非法字段', () => {
    expect(parseWorkspaceLayout(JSON.stringify({ leftOpen: false, inspectorTab: 'check', dockOpen: 'no' }))).toEqual({
      leftOpen: false,
      inspectorOpen: true,
      dockOpen: true,
      inspectorTab: 'check',
    });
  });

  it('序列化后可无损恢复', () => {
    const value = { leftOpen: false, inspectorOpen: true, dockOpen: false, inspectorTab: 'properties' as const };
    expect(parseWorkspaceLayout(serializeWorkspaceLayout(value))).toEqual(value);
  });
});
