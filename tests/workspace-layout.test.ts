import { describe, expect, it } from 'vitest';
import {
  COMPACT_WORKSPACE_MAX_WIDTH,
  DEFAULT_WORKSPACE_LAYOUT,
  defaultWorkspaceLayoutForWidth,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
} from '../src/product/workspace-layout';

describe('M1.5 工作台布局偏好', () => {
  it('首次进入窄屏时收起检查器，AI 面板不再占用固定底栏', () => {
    expect(defaultWorkspaceLayoutForWidth(COMPACT_WORKSPACE_MAX_WIDTH)).toEqual({
      ...DEFAULT_WORKSPACE_LAYOUT,
      inspectorOpen: false,
    });
    expect(defaultWorkspaceLayoutForWidth(COMPACT_WORKSPACE_MAX_WIDTH + 1)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('无记录或损坏记录回退到产品默认值', () => {
    expect(parseWorkspaceLayout(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(parseWorkspaceLayout('{bad json')).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('逐项接收合法偏好并忽略非法字段', () => {
    expect(parseWorkspaceLayout(JSON.stringify({ leftOpen: false, inspectorTab: 'history', creationOpen: 'no' }))).toEqual({
      leftOpen: false,
      inspectorOpen: true,
      creationOpen: false,
      inspectorTab: 'history',
    });
  });

  it('序列化后可无损恢复', () => {
    const value = { leftOpen: false, inspectorOpen: true, creationOpen: true, inspectorTab: 'properties' as const };
    expect(parseWorkspaceLayout(serializeWorkspaceLayout(value))).toEqual(value);
  });
});
