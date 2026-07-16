export type InspectorTab = 'properties' | 'check';

export interface WorkspaceLayout {
  leftOpen: boolean;
  inspectorOpen: boolean;
  dockOpen: boolean;
  inspectorTab: InspectorTab;
}

export const WORKSPACE_LAYOUT_KEY = '3dstd:m15-workspace-layout';

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  leftOpen: true,
  inspectorOpen: true,
  dockOpen: true,
  inspectorTab: 'properties',
};

export const COMPACT_WORKSPACE_MAX_WIDTH = 1366;

/**
 * 首次进入时按可用宽度给出产品默认布局。窄屏优先保住视口，检查器与 AI 底栏
 * 仍可从顶栏打开，但以抽屉覆盖而不是继续挤压中央编辑区。
 */
export function defaultWorkspaceLayoutForWidth(width: number): WorkspaceLayout {
  if (width <= COMPACT_WORKSPACE_MAX_WIDTH) {
    return {
      ...DEFAULT_WORKSPACE_LAYOUT,
      inspectorOpen: false,
      dockOpen: false,
    };
  }
  return { ...DEFAULT_WORKSPACE_LAYOUT };
}

/**
 * M1.5 只持久化界面偏好，不把它混入项目文档或历史栈(C1/C5)。
 * 解析失败、旧字段或非法值都逐项回退，避免一次坏数据让工作台无法打开。
 */
export function parseWorkspaceLayout(raw: string | null): WorkspaceLayout {
  if (!raw) return { ...DEFAULT_WORKSPACE_LAYOUT };
  try {
    const value = JSON.parse(raw) as Partial<WorkspaceLayout> | null;
    if (!value || typeof value !== 'object') return { ...DEFAULT_WORKSPACE_LAYOUT };
    return {
      leftOpen: typeof value.leftOpen === 'boolean' ? value.leftOpen : true,
      inspectorOpen: typeof value.inspectorOpen === 'boolean' ? value.inspectorOpen : true,
      dockOpen: typeof value.dockOpen === 'boolean' ? value.dockOpen : true,
      inspectorTab: value.inspectorTab === 'check' || value.inspectorTab === 'properties'
        ? value.inspectorTab
        : 'properties',
    };
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
}

export const serializeWorkspaceLayout = (layout: WorkspaceLayout): string => JSON.stringify(layout);
