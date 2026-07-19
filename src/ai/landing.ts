// T16 · AI 结果落入汇聚点(AI-09 / HIST-05)。
//
// 生成结果不另造解析器:仍走 T10/T11 的 startImport → finalize，确保单位、几何预检、
// 缩略图、IndexedDB 与普通导入同源。差异仅由 ImportOptions 显式携带:
// AI 来源/生成参数 + 单条「AI 生成落入」历史 + 落场后的聚焦与首次打印检查。

import { runPrintCheck, useCheck } from '../check/check-state';
import { startImport, type ImportOptions, type ImportResult } from '../importer/ingest';
import { sendCam, useUi } from '../state/store';

export interface AiLandingContext {
  prompt: string;
  type: 'text' | 'image' | 'multiview';
  taskId: string | null;
  engine: string | null;
}

export interface LandingEffects {
  focusAfterMount: () => void;
  runCheck: () => boolean;
  retryCheckWhenIdle: () => void;
  notify: (text: string) => void;
}

function focusAfterMount() {
  // placeInstance 的 dispatch 已让 React 重渲染，但 meshRegistry 要等 Canvas commit 才有新实例。
  // 下一帧再发 focus，避免聚焦命令抢在 mesh 注册之前落空。
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => sendCam({ kind: 'focus' }));
  else setTimeout(() => sendCam({ kind: 'focus' }), 0);
}

function retryCheckWhenIdle() {
  // 若用户恰在手动检查，旧轮不含刚落入的实例且会因 editVersion 变过期；
  // 等它收尾后再跑一轮，保证 AI-09 的「首检」不被吞掉。
  const unsubscribe = useCheck.subscribe((s) => {
    if (s.phase === 'running') return;
    unsubscribe();
    queueMicrotask(() => void runPrintCheck());
  });
}

const realEffects: LandingEffects = {
  focusAfterMount,
  runCheck: () => runPrintCheck(),
  retryCheckWhenIdle,
  notify: (text) => useUi.getState().setToast(text),
};

/** 落场后的只读/异步效果均不入历史；唯一文档写入已由 placeInstance 原子完成。 */
export function completeAiLanding(
  result: ImportResult,
  effects: LandingEffects = realEffects,
) {
  if (!result.instanceId) return;
  effects.focusAfterMount();
  if (!effects.runCheck()) effects.retryCheckWhenIdle();
  effects.notify('AI 结果已入库并落场：已选中、聚焦、沉底，首次打印检查已启动');
}

export function aiImportOptions(
  context: AiLandingContext,
  onComplete: (result: ImportResult) => void = (result) => completeAiLanding(result),
): ImportOptions {
  return {
    source: 'ai',
    genParams: {
      prompt: context.prompt,
      type: context.type,
      taskId: context.taskId,
      engine: context.engine ?? 'unknown',
    },
    placementLabel: 'AI 生成落入',
    placementOp: 'aiPlace',
    onComplete,
  };
}

export function startAiLanding(file: File, context: AiLandingContext) {
  startImport([file], 'viewport', aiImportOptions(context));
}
