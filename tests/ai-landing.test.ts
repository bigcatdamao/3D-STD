// T16 汇聚回归:AI 接受仍走 T10/T11 finalize，但资产来源/生成参数、HIST-05 单条历史、
// 聚焦与首次检查均在落场完成点接通。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiImportOptions, completeAiLanding } from '../src/ai/landing';
import { finalize } from '../src/importer/ingest';
import type { InstanceNode } from '../src/kernel/types';
import { doc, geometryRegistry, thumbRegistry, useUi } from '../src/state/store';

const META = {
  faces: 1,
  vertices: 3,
  bboxRaw: {
    min: [-5, -5, -2] as [number, number, number],
    max: [5, 5, 8] as [number, number, number],
  },
  watertight: false,
  degenerateCount: 0,
  boundaryEdges: 3,
  nonManifoldEdges: 0,
  materialMissing: false,
  gltfBaked: true,
};

function wipe() {
  for (const id of [...doc.nodes.keys()]) doc.nodes.delete(id);
  for (const k of [...doc.order.keys()]) doc.order.set(k, []);
  for (const id of [...doc.assets.keys()]) {
    doc.assets.delete(id);
    geometryRegistry.delete(id);
    thumbRegistry.delete(id);
  }
  doc.selection.clear();
  useUi.setState({ toast: null, importJobs: [] });
}

beforeEach(wipe);

describe('AI 结果 → 资产 → 实例(T16 / AI-09 / HIST-05)', () => {
  it('记录 AI 来源与完整生成上下文，落根层级、选中、沉底，且历史只有 AI 落入一步', () => {
    const completed = vi.fn();
    const options = aiImportOptions(
      { prompt: '一只低多边形狐狸', type: 'text', taskId: 'task_16', engine: 'tripo' },
      completed,
    );
    const assetId = finalize(
      'ai-job',
      '一只低多边形狐狸',
      new Float32Array([-5, -5, -2, 5, -5, -2, 0, 5, 8]),
      null,
      META,
      'm',
      1,
      0,
      'viewport',
      options,
    );

    const asset = doc.assets.get(assetId)!;
    expect(asset.source).toBe('ai');
    expect(asset.genParams).toEqual({
      prompt: '一只低多边形狐狸',
      type: 'text',
      taskId: 'task_16',
      engine: 'tripo',
    });
    const inst = [...doc.nodes.values()].find(
      (n): n is InstanceNode => n.kind === 'instance' && n.assetId === assetId,
    )!;
    expect(inst.parentId).toBeNull();
    expect(inst.transform.position).toEqual([0, 0, 2]);
    expect([...doc.selection]).toEqual([inst.id]);
    expect(doc.history.list().at(-1)).toMatchObject({ op: 'aiPlace', label: 'AI 生成落入' });
    expect(completed).toHaveBeenCalledWith({ assetId, instanceId: inst.id });

    doc.history.undo();
    expect(doc.nodes.has(inst.id)).toBe(false);
    expect(doc.assets.has(assetId)).toBe(true); // HIST-05:昂贵资产保留
  });

  it('落场完成后触发聚焦与首检；检查正忙时登记收尾重跑', () => {
    const focusAfterMount = vi.fn();
    const runCheck = vi.fn(() => false);
    const retryCheckWhenIdle = vi.fn();
    const notify = vi.fn();

    completeAiLanding(
      { assetId: 'ast_ai', instanceId: 'ins_ai' },
      { focusAfterMount, runCheck, retryCheckWhenIdle, notify },
    );

    expect(focusAfterMount).toHaveBeenCalledOnce();
    expect(runCheck).toHaveBeenCalledOnce();
    expect(retryCheckWhenIdle).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('首次打印检查已启动'));
  });

  it('仅入库结果没有实例时不误触发聚焦或检查', () => {
    const effects = {
      focusAfterMount: vi.fn(),
      runCheck: vi.fn(() => true),
      retryCheckWhenIdle: vi.fn(),
      notify: vi.fn(),
    };
    completeAiLanding({ assetId: 'ast_ai', instanceId: null }, effects);
    expect(effects.focusAfterMount).not.toHaveBeenCalled();
    expect(effects.runCheck).not.toHaveBeenCalled();
  });
});
