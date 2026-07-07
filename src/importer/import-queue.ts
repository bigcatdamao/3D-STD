// 导入队列(IMP-04 并发上限 3 / IMP-08 失败可重试 / IMP 边界 3 解析中删除 = 取消,Worker 终止)。
// Worker 生成器可注入 —— 队列状态机以纯逻辑接受单元测试,真实 Worker 只在浏览器侧装配。

import type { Format } from './parse-core';
import type { WorkerReply } from './parse.worker';

export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: WorkerReply }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SpawnWorker = () => WorkerLike;

export type JobPhase = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface ImportJob {
  id: string;
  name: string;
  file: Blob;
  format: Format;
  slot: number; // 同批第几件(落床横向错位用)
  batchSize: number;
  phase: JobPhase;
  pct: number;
  phaseText: string;
  error?: { code: string; message: string; retryable: boolean };
}

export interface QueueEvents {
  onUpdate: (job: ImportJob) => void; // 任何状态/进度变化(含入队)
  onResult: (job: ImportJob, ok: Extract<WorkerReply, { t: 'ok' }>) => void;
}

export const CONCURRENCY_LIMIT = 3;

let jobSeq = 0;

export class ImportQueue {
  private jobs = new Map<string, ImportJob>();
  private waiting: string[] = []; // FIFO
  private running = new Map<string, WorkerLike>();

  constructor(
    private spawn: SpawnWorker,
    private events: QueueEvents,
    private limit = CONCURRENCY_LIMIT,
  ) {}

  get(id: string): ImportJob | undefined {
    return this.jobs.get(id);
  }

  enqueue(name: string, file: Blob, format: Format, slot: number, batchSize: number): ImportJob {
    const job: ImportJob = {
      id: `imp_${(++jobSeq).toString(36)}`,
      name,
      file,
      format,
      slot,
      batchSize,
      phase: 'queued',
      pct: 0,
      phaseText: '排队中',
    };
    this.jobs.set(job.id, job);
    this.waiting.push(job.id);
    this.events.onUpdate({ ...job });
    this.pump();
    return job;
  }

  /** 入口即分类的失败(白名单/超限):直接以失败态挂上条目,不静默消失(IMP-08) */
  enqueueFailed(name: string, error: ImportJob['error']): ImportJob {
    const job: ImportJob = {
      id: `imp_${(++jobSeq).toString(36)}`,
      name,
      file: new Blob(),
      format: 'stl',
      slot: 0,
      batchSize: 1,
      phase: 'failed',
      pct: 0,
      phaseText: '失败',
      error,
    };
    this.jobs.set(job.id, job);
    this.events.onUpdate({ ...job });
    return job;
  }

  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.phase === 'queued') {
      this.waiting = this.waiting.filter((w) => w !== id);
    } else if (job.phase === 'running') {
      this.running.get(id)?.terminate(); // 边界 3:解析中取消 = Worker 终止,槽位回收
      this.running.delete(id);
    } else {
      return; // 终态任务无可取消
    }
    job.phase = 'canceled';
    job.phaseText = '已取消';
    this.events.onUpdate({ ...job });
    this.pump();
  }

  retry(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.phase !== 'failed' || !job.error?.retryable) return;
    job.phase = 'queued';
    job.pct = 0;
    job.phaseText = '排队中';
    job.error = undefined;
    this.waiting.push(id);
    this.events.onUpdate({ ...job });
    this.pump();
  }

  /** 终态条目移除(失败「移除」按钮 / 完成条目自动清理) */
  remove(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.phase === 'running' || job.phase === 'queued') return;
    this.jobs.delete(id);
  }

  runningCount(): number {
    return this.running.size;
  }

  private pump() {
    while (this.running.size < this.limit && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.phase !== 'queued') continue;
      this.start(job);
    }
  }

  private start(job: ImportJob) {
    const w = this.spawn();
    this.running.set(job.id, w);
    job.phase = 'running';
    job.pct = 2;
    job.phaseText = '启动解析';
    this.events.onUpdate({ ...job });

    const finish = () => {
      this.running.get(job.id)?.terminate(); // 一任务一 Worker:结束即回收,内存峰值不叠加
      this.running.delete(job.id);
      this.pump();
    };

    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.jobId !== job.id) return;
      if (job.phase !== 'running') return; // 取消竞态:终止指令后仍可能有在途消息,丢弃
      if (m.t === 'progress') {
        job.pct = m.pct;
        job.phaseText = m.phase;
        this.events.onUpdate({ ...job });
      } else if (m.t === 'ok') {
        job.pct = 100;
        job.phase = 'done';
        job.phaseText = '完成';
        finish();
        this.events.onResult({ ...job }, m);
        this.events.onUpdate({ ...job });
      } else {
        job.phase = 'failed';
        job.phaseText = '失败';
        job.error = { code: m.code, message: m.message, retryable: m.retryable };
        finish();
        this.events.onUpdate({ ...job });
      }
    };
    w.onerror = () => {
      if (job.phase !== 'running') return;
      job.phase = 'failed';
      job.phaseText = '失败';
      job.error = { code: 'internal', message: '解析进程异常退出', retryable: true };
      finish();
      this.events.onUpdate({ ...job });
    };

    w.postMessage({ jobId: job.id, name: job.name, format: job.format, file: job.file });
  }
}
