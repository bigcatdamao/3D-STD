// IMP-04 并发上限 3 / IMP-08 失败可重试 / 边界 3 取消即终止 —— 队列状态机纯逻辑验证(假 Worker 注入)。
import { beforeEach, describe, expect, it } from 'vitest';
import { CONCURRENCY_LIMIT, ImportQueue, type ImportJob, type WorkerLike } from '../src/importer/import-queue';
import type { WorkerReply } from '../src/importer/parse.worker';

class FakeWorker implements WorkerLike {
  static live: FakeWorker[] = [];
  onmessage: ((ev: { data: WorkerReply }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  terminated = false;
  jobId = '';
  postMessage(msg: unknown) {
    this.jobId = (msg as { jobId: string }).jobId;
  }
  terminate() {
    this.terminated = true;
  }
  emit(reply: WorkerReply) {
    this.onmessage?.({ data: reply });
  }
  ok() {
    this.emit({
      t: 'ok',
      jobId: this.jobId,
      positions: new ArrayBuffer(0),
      normals: null,
      meta: {
        faces: 1,
        vertices: 3,
        bboxRaw: { min: [0, 0, 0], max: [1, 1, 1] },
        watertight: true,
        degenerateCount: 0,
        boundaryEdges: 0,
        nonManifoldEdges: 0,
        materialMissing: false,
        gltfBaked: false,
      },
    });
  }
  fail(retryable: boolean) {
    this.emit({ t: 'err', jobId: this.jobId, code: 'corrupt', message: '无法解析', retryable });
  }
}

let updates: ImportJob[];
let results: string[];
let q: ImportQueue;

beforeEach(() => {
  FakeWorker.live = [];
  updates = [];
  results = [];
  q = new ImportQueue(
    () => {
      const w = new FakeWorker();
      FakeWorker.live.push(w);
      return w;
    },
    {
      onUpdate: (j) => updates.push(j),
      onResult: (j) => results.push(j.name),
    },
  );
});

const blob = () => new Blob(['x']);
const last = (id: string) => [...updates].reverse().find((u) => u.id === id)!;

describe('并发与顺序(IMP-04)', () => {
  it('并发上限 3,第 4 件排队;完成一件后按 FIFO 放行', () => {
    const jobs = ['a', 'b', 'c', 'd', 'e'].map((n) => q.enqueue(n, blob(), 'stl', 0, 5));
    expect(q.runningCount()).toBe(CONCURRENCY_LIMIT);
    expect(last(jobs[3].id).phase).toBe('queued');

    FakeWorker.live[0].ok(); // a 完成
    expect(results).toEqual(['a']);
    expect(q.runningCount()).toBe(3);
    expect(last(jobs[3].id).phase).toBe('running'); // d 先于 e(FIFO)
    expect(last(jobs[4].id).phase).toBe('queued');
  });

  it('结果 Worker 即用即弃:完成后该 Worker 被终止回收', () => {
    q.enqueue('a', blob(), 'stl', 0, 1);
    FakeWorker.live[0].ok();
    expect(FakeWorker.live[0].terminated).toBe(true);
  });
});

describe('取消(边界 3:解析中删除 = 取消,Worker 终止)', () => {
  it('排队中取消:不启动,直接终态', () => {
    ['a', 'b', 'c'].forEach((n) => q.enqueue(n, blob(), 'stl', 0, 4));
    const d = q.enqueue('d', blob(), 'stl', 3, 4);
    q.cancel(d.id);
    expect(last(d.id).phase).toBe('canceled');
    FakeWorker.live[0].ok();
    expect(FakeWorker.live.length).toBe(3); // 槽位空出也不会复活已取消任务
  });

  it('运行中取消:终止 Worker、槽位回收放行下一件;在途消息被丢弃', () => {
    const [a] = ['a', 'b', 'c', 'd'].map((n) => q.enqueue(n, blob(), 'stl', 0, 4));
    const w0 = FakeWorker.live[0];
    q.cancel(a.id);
    expect(w0.terminated).toBe(true);
    expect(q.runningCount()).toBe(3); // d 顶上
    w0.ok(); // 终止指令后的在途消息
    expect(last(a.id).phase).toBe('canceled');
    expect(results).not.toContain('a');
  });
});

describe('失败与重试(IMP-08)', () => {
  it('可重试失败:错误分类挂条目,retry 重新排队并跑通', () => {
    const a = q.enqueue('a', blob(), 'stl', 0, 1);
    FakeWorker.live[0].fail(true);
    expect(last(a.id).phase).toBe('failed');
    expect(last(a.id).error?.message).toBe('无法解析');

    q.retry(a.id);
    expect(last(a.id).phase).toBe('running');
    FakeWorker.live[1].ok();
    expect(last(a.id).phase).toBe('done');
  });

  it('不可重试失败:retry 为空操作', () => {
    const a = q.enqueue('a', blob(), 'stl', 0, 1);
    FakeWorker.live[0].fail(false);
    q.retry(a.id);
    expect(last(a.id).phase).toBe('failed');
    expect(q.runningCount()).toBe(0);
  });

  it('入口即分类:enqueueFailed 直接挂失败条目,不占并发槽', () => {
    const j = q.enqueueFailed('x.fbx', { code: 'rejected-fbx', message: '暂不支持 FBX', retryable: false });
    expect(last(j.id).phase).toBe('failed');
    expect(q.runningCount()).toBe(0);
  });
});
