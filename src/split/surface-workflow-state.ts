import { useEffect, useState } from 'react';
import { create } from 'zustand';

export type SurfaceWorkflowMode = 'stroke' | 'facePaint';
export type SurfaceStrokeInputKind = 'click' | 'draw';

interface SurfaceWorkflowState {
  mode: SurfaceWorkflowMode;
  strokeSegmentEnds: number[];
  strokeSegmentKinds: SurfaceStrokeInputKind[];
}

const initialState: SurfaceWorkflowState = {
  mode: 'stroke',
  strokeSegmentEnds: [],
  strokeSegmentKinds: [],
};

export const useSurfaceWorkflow = create<SurfaceWorkflowState>()(() => initialState);

/** SSR 与客户端首帧均读取当前模式，便于面板测试和工具切换。 */
export function useSurfaceWorkflowSnapshot(): SurfaceWorkflowState {
  const [state, setState] = useState(() => useSurfaceWorkflow.getState());
  useEffect(() => {
    setState(useSurfaceWorkflow.getState());
    return useSurfaceWorkflow.subscribe(setState);
  }, []);
  return state;
}

export function setSurfaceWorkflowMode(mode: SurfaceWorkflowMode): void {
  useSurfaceWorkflow.setState({
    mode,
    strokeSegmentEnds: [],
    strokeSegmentKinds: [],
  });
}

export function recordSurfaceStrokeSegment(
  pointCount: number,
  kind: SurfaceStrokeInputKind,
): void {
  const state = useSurfaceWorkflow.getState();
  const previousEnd = state.strokeSegmentEnds.at(-1) ?? 0;
  if (!Number.isInteger(pointCount) || pointCount <= previousEnd) return;
  useSurfaceWorkflow.setState({
    strokeSegmentEnds: [...state.strokeSegmentEnds, pointCount],
    strokeSegmentKinds: [...state.strokeSegmentKinds, kind],
  });
}

/** 删除最后一个输入段，并返回删除后应保留的点数。 */
export function popSurfaceStrokeSegment(): number | null {
  const state = useSurfaceWorkflow.getState();
  if (!state.strokeSegmentEnds.length) return null;
  const strokeSegmentEnds = state.strokeSegmentEnds.slice(0, -1);
  const strokeSegmentKinds = state.strokeSegmentKinds.slice(0, -1);
  useSurfaceWorkflow.setState({ strokeSegmentEnds, strokeSegmentKinds });
  return strokeSegmentEnds.at(-1) ?? 0;
}

export function resetSurfaceStrokeSession(): void {
  useSurfaceWorkflow.setState({
    strokeSegmentEnds: [],
    strokeSegmentKinds: [],
  });
}

export function resetSurfaceWorkflowMode(): void {
  useSurfaceWorkflow.setState(initialState, true);
}
