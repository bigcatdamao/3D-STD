import { useEffect as useReactEffect, useState as useReactState } from 'react';
import { create } from 'zustand';
import { liveIssues, reportIsStale, useCheck } from '../check/check-state';
import { doc, useUi } from '../state/store';
import { buildMockSplitAnalysis, buildSplitAnalysisContext } from './split-analysis-logic';
import type {
  PrintProcess,
  SplitAnalysisContext,
  SplitAnalysisResult,
  SplitPriority,
} from './split-analysis-types';

export type SplitAnalysisPhase = 'idle' | 'running' | 'done' | 'failed';

export const DEFAULT_SPLIT_GOAL = '判断当前模型是否需要拆件，并在适配打印空间的前提下尽量减少支撑、保持外观。';
export const DEFAULT_SPLIT_PRIORITIES: SplitPriority[] = ['fit_build_volume', 'reduce_support'];

interface SplitAnalysisState {
  phase: SplitAnalysisPhase;
  goal: string;
  process: PrintProcess;
  priorities: SplitPriority[];
  context: SplitAnalysisContext | null;
  result: SplitAnalysisResult | null;
  selectedSchemeId: string | null;
  runMeta: { editVersion: number; bed: { x: number; y: number; z: number } } | null;
  error: string | null;
  setGoal: (goal: string) => void;
  setProcess: (process: PrintProcess) => void;
  togglePriority: (priority: SplitPriority) => void;
  selectScheme: (schemeId: string) => void;
  reset: () => void;
}
let activeRun = 0;

export const useSplitAnalysis = create<SplitAnalysisState>()((set) => ({
  phase: 'idle',
  goal: DEFAULT_SPLIT_GOAL,
  process: 'fdm',
  priorities: [...DEFAULT_SPLIT_PRIORITIES],
  context: null,
  result: null,
  selectedSchemeId: null,
  runMeta: null,
  error: null,
  setGoal: (goal) => set({ goal }),
  setProcess: (process) => set({ process }),
  togglePriority: (priority) => set((state) => ({
    priorities: state.priorities.includes(priority)
      ? state.priorities.filter((item) => item !== priority)
      : [...state.priorities, priority],
  })),
  selectScheme: (selectedSchemeId) => set({ selectedSchemeId }),
  reset: () => {
    activeRun += 1;
    set({
      phase: 'idle',
      context: null,
      result: null,
      selectedSchemeId: null,
      runMeta: null,
      error: null,
    });
  },
}));

/** 与打印检查状态桥保持同一 SSR 安全订阅方式。 */
export function useSplitAnalysisSnapshot(): SplitAnalysisState {
  const [state, setState] = useReactState(() => useSplitAnalysis.getState());
  useReactEffect(() => {
    setState(useSplitAnalysis.getState());
    return useSplitAnalysis.subscribe(setState);
  }, []);
  return state;
}

export function splitAnalysisIsStale(): boolean {
  const meta = useSplitAnalysis.getState().runMeta;
  if (!meta) return false;
  const bed = useUi.getState().bed;
  return meta.editVersion !== doc.editVersion || meta.bed.x !== bed.x || meta.bed.y !== bed.y || meta.bed.z !== bed.z;
}

/** M1.6.1 体验原型：本地规则生成与正式 schema 同形的建议，不调用模型、不修改场景。 */
export function runMockSplitAnalysis(delayMs = 650): boolean {
  const state = useSplitAnalysis.getState();
  if (!state.goal.trim()) {
    useSplitAnalysis.setState({ phase: 'failed', error: '请先填写拆件目标。' });
    return false;
  }

  const check = useCheck.getState();
  const bed = { ...useUi.getState().bed };
  const context = buildSplitAnalysisContext(doc, {
    goal: state.goal.trim(),
    priorities: state.priorities,
    process: state.process,
    bed,
    check: {
      phase: check.phase,
      stale: reportIsStale(),
      timedOut: check.timedOut,
      unfinishedCount: check.unfinished.length,
      issues: liveIssues(),
      summary: check.summary,
    },
  });

  if (context.objectCount === 0) {
    useSplitAnalysis.setState({ phase: 'failed', error: '当前没有可分析的模型，请先生成或导入模型。' });
    return false;
  }

  const runId = ++activeRun;
  useSplitAnalysis.setState({
    phase: 'running',
    context,
    result: null,
    selectedSchemeId: null,
    runMeta: { editVersion: doc.editVersion, bed },
    error: null,
  });

  const complete = () => {
    if (runId !== activeRun) return;
    const result = buildMockSplitAnalysis(context);
    useSplitAnalysis.setState({
      phase: 'done',
      result,
      selectedSchemeId: result.schemes.find((scheme) => scheme.recommended)?.id ?? result.schemes[0]?.id ?? null,
    });
  };
  if (delayMs <= 0) complete();
  else globalThis.setTimeout(complete, delayMs);
  return true;
}
