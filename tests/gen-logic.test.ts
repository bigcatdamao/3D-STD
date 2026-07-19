// T12 · AI 生成前端纯逻辑单测。
// 覆盖:AI-01 校验(文生空/超长、图生格式/大小)、AI-04 分频、AI-03 状态迁移全路径、
//       AI-05 三分类→三出路映射、AI 边界 1 票据序列化/解析/恢复、结果文件名。

import { describe, expect, it } from 'vitest';
import type { EngineTask, GenerateResponse } from '../worker/api-types';
import {
  applyTask,
  inputLockedIn,
  emptyContext,
  idleState,
  onSubmitted,
  outletOf,
  parseActiveTicket,
  pollDelayOf,
  PROMPT_MAX_CHARS,
  resultFileName,
  resumeState,
  serializeActive,
  validateImageFile,
  validateImageSelection,
  validateText,
  type GenState,
} from '../src/ai/gen-logic';

const ctx = (prompt = '一只章鱼形状的花盆') => ({ type: 'text' as const, prompt, images: [] });

const task = (t: Partial<EngineTask>): EngineTask => ({
  taskId: 't_1',
  status: 'queued',
  progress: 0,
  ...t,
});

describe('AI-01 前端即时校验(失败不发请求 = 零配额消耗)', () => {
  it('空输入与纯空白被拒', () => {
    expect(validateText('').ok).toBe(false);
    expect(validateText('   \n ').ok).toBe(false);
  });

  it('超长被拒且上限与服务侧一致(2000)', () => {
    expect(PROMPT_MAX_CHARS).toBe(2000);
    expect(validateText('a'.repeat(2000)).ok).toBe(true);
    const vMax = validateText('a'.repeat(1025), 1024); // T13a-fix1:上限可由引擎上报收紧
    expect(vMax.ok).toBe(false);
    if (!vMax.ok) expect(vMax.message).toContain('1024');
    expect(validateText('a'.repeat(1024), 1024).ok).toBe(true);
    const v = validateText('a'.repeat(2001));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('prompt_too_long');
  });

  it('图生校验:格式白名单 + 10MB 上限(通道随 T13,规则先行入档)', () => {
    expect(validateImageFile('cat.PNG', 1024).ok).toBe(true);
    expect(validateImageFile('cat.webp', 1024).ok).toBe(true);
    expect(validateImageFile('cat.gif', 1024).ok).toBe(false);
    expect(validateImageFile('cat.png', 10 * 1024 * 1024 + 1).ok).toBe(false);
  });

  it('单图必须 1 张；多图正面必填且允许 2–3 张', () => {
    const front = { view: 'front' as const, name: 'front.png', size: 1024, mime: 'image/png' };
    const left = { view: 'left' as const, name: 'left.jpg', size: 1024, mime: 'image/jpeg' };
    const right = { view: 'right' as const, name: 'right.webp', size: 1024, mime: 'image/webp' };
    expect(validateImageSelection('image', [front]).ok).toBe(true);
    expect(validateImageSelection('image', []).ok).toBe(false);
    expect(validateImageSelection('multiview', [front]).ok).toBe(false);
    expect(validateImageSelection('multiview', [front, left]).ok).toBe(true);
    expect(validateImageSelection('multiview', [front, left, right]).ok).toBe(true);
    expect(validateImageSelection('multiview', [left, right]).ok).toBe(false);
  });
});

describe('AI-04 轮询分频', () => {
  it('排队 5s / 生成 2s', () => {
    expect(pollDelayOf('queued')).toBe(5000);
    expect(pollDelayOf('running')).toBe(2000);
  });
});

describe('AI-03 状态迁移', () => {
  it('提交成功 → queued 携排队位置;mock 秒进 running 亦正确落位', () => {
    const respQ: GenerateResponse = { ok: true, engine: 'mock', task: task({ status: 'queued', queuePosition: 2 }) };
    const s1 = onSubmitted(ctx(), respQ, 1000);
    expect(s1.phase).toBe('queued');
    expect(s1.queuePosition).toBe(2);
    expect(s1.taskId).toBe('t_1');
    expect(s1.startedAt).toBe(1000);

    const respR: GenerateResponse = { ok: true, engine: 'mock', task: task({ status: 'running', progress: 5 }) };
    expect(onSubmitted(ctx(), respR, 1000).phase).toBe('running');
  });

  it('queued → running:进度与位置随轮询刷新', () => {
    let s = onSubmitted(ctx(), { ok: true, engine: 'mock', task: task({ queuePosition: 3 }) }, 0);
    s = applyTask(s, task({ status: 'queued', queuePosition: 1 }));
    expect(s.queuePosition).toBe(1);
    s = applyTask(s, task({ status: 'running', progress: 40 }));
    expect(s.phase).toBe('running');
    expect(s.progress).toBe(40);
    expect(s.queuePosition).toBeUndefined();
  });

  it('running → success:进度封顶 100,携结果链接', () => {
    let s = onSubmitted(ctx(), { ok: true, engine: 'mock', task: task({ status: 'running', progress: 80 }) }, 0);
    s = applyTask(s, task({ status: 'success', progress: 100, resultUrl: '/mock/cube.glb' }));
    expect(s.phase).toBe('success');
    expect(s.progress).toBe(100);
    expect(s.resultUrl).toBe('/mock/cube.glb');
  });

  it('failed:三分类各自落位;未知原因兜底为 timeout(技术方案 §4)', () => {
    const base = onSubmitted(ctx(), { ok: true, engine: 'mock', task: task({}) }, 0);
    for (const reason of ['timeout', 'moderation', 'service'] as const) {
      const s = applyTask(base, task({ status: 'failed', failReason: reason }), true);
      expect(s.phase).toBe('failed');
      expect(s.failReason).toBe(reason);
      expect(s.refunded).toBe(true);
    }
    const s = applyTask(base, task({ status: 'failed' }));
    expect(s.failReason).toBe('timeout');
  });
});

describe('AI-05 三分类三出路(禁止合并为单一失败弹窗)', () => {
  it('timeout→重试 / moderation→修改输入 / service→稍后再试,动作语义各异', () => {
    const t = outletOf('timeout');
    const m = outletOf('moderation');
    const s = outletOf('service');
    expect(t.action).toBe('retry');
    expect(m.action).toBe('edit');
    expect(s.action).toBe('dismiss');
    // 三出路文案互不相同 = 结构上不可能合并成一个弹窗
    expect(new Set([t.outlet, m.outlet, s.outlet]).size).toBe(3);
    // service 类不暴露账务/引擎细节
    expect(s.message).toContain('稍后再试');
    expect(s.message).not.toMatch(/credit|账务|引擎额度/);
  });
});

describe('AI 边界 1 · 刷新恢复票据', () => {
  it('活动态(queued/running)可序列化;idle 与终态返回 null', () => {
    const active = onSubmitted(ctx('恢复测试'), { ok: true, engine: 'mock', task: task({}) }, 42);
    expect(serializeActive(active)).toBeTruthy();
    expect(serializeActive(applyTask(active, task({ status: 'running', progress: 10 })))).toBeTruthy();
    expect(serializeActive(idleState())).toBeNull();
    expect(serializeActive(applyTask(active, task({ status: 'success', resultUrl: 'u' })))).toBeNull();
    expect(serializeActive(applyTask(active, task({ status: 'failed', failReason: 'service' })))).toBeNull();
  });

  it('序列化 → 解析 → 恢复:上下文完整往返(AI-08 的持久化面)', () => {
    const active = onSubmitted(ctx('往返上下文'), { ok: true, engine: 'mock', task: task({}) }, 42);
    const ticket = parseActiveTicket(serializeActive(active));
    expect(ticket).not.toBeNull();
    const resumed = resumeState(ticket as NonNullable<typeof ticket>);
    expect(resumed.phase).toBe('queued'); // 先保守呈现,首拍轮询立即校正
    expect(resumed.taskId).toBe('t_1');
    expect(resumed.context.prompt).toBe('往返上下文');
    expect(resumed.startedAt).toBe(42);
  });

  it('畸形票据安全拒收(不炸、返回 null)', () => {
    expect(parseActiveTicket(null)).toBeNull();
    expect(parseActiveTicket('not json')).toBeNull();
    expect(parseActiveTicket('{}')).toBeNull();
    expect(parseActiveTicket(JSON.stringify({ taskId: 't', context: { type: 'video', prompt: 'x' } }))).toBeNull();
    expect(parseActiveTicket(JSON.stringify({ taskId: '', context: { type: 'text', prompt: 'x' } }))).toBeNull();
  });
});

describe('输入区锁定规则(回归哨兵:失败态必须可编辑)', () => {
  it('在途与预览确认锁定;idle/failed/canceled 可编辑', () => {
    // 曾有 bug:failed 态输入框被锁,timeout 失败只有「重试」一个出口,想改 prompt 被锁死。
    expect(inputLockedIn('submitting')).toBe(true);
    expect(inputLockedIn('queued')).toBe(true);
    expect(inputLockedIn('running')).toBe(true);
    expect(inputLockedIn('success')).toBe(true); // 三选(接受/调整/丢弃)须显式,不允许静默略过
    expect(inputLockedIn('idle')).toBe(false);
    expect(inputLockedIn('failed')).toBe(false);
    expect(inputLockedIn('canceled')).toBe(false);
  });
});

describe('结果文件名(接受 → T10 导入管线)', () => {
  it('prompt 清洗为合法文件名,空值兜底', () => {
    expect(resultFileName('一只章鱼 花盆')).toBe('一只章鱼-花盆.glb');
    expect(resultFileName('a/b\\c:d*e')).toBe('a-b-c-d-e.glb');
    expect(resultFileName('   ')).toBe('ai-model.glb');
    expect(resultFileName('x'.repeat(100)).length).toBeLessThanOrEqual(44 + 4);
  });

  it('@mock: 演练指令不进对象名(纯指令 prompt 兜底为 ai-model)', () => {
    expect(resultFileName('一个球 @mock:run=30s')).toBe('一个球.glb');
    expect(resultFileName('一个杯子 @mock:queue=8s @mock:run=20s')).toBe('一个杯子.glb');
    expect(resultFileName('@mock:fail=timeout')).toBe('ai-model.glb');
  });
});

// 状态类型完备性哨兵:新增 phase 时此处编译期报警,提醒同步 UI 分支
const _phaseSentinel: GenState['phase'][] = ['idle', 'submitting', 'queued', 'running', 'success', 'failed', 'canceled'];
void _phaseSentinel;
