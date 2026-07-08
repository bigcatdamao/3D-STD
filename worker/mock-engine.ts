// T4:mock 引擎 —— 统一任务协议(技术方案 D4 / PRD AI-10)的第一个实现。
//
// 无状态设计:任务的全部生命周期(提交时刻、排队/生成时长、结局)在提交瞬间一次定案,
// 编码进 taskId 本身;query 用「当前时间 vs 时间表」纯计算出状态。收益:
//   ① 零存储成本(不占 DO/KV,存储分工表不动,KV 仍按计划 T13 启用);
//   ② 跨 isolate 回收 / 多实例天然一致 —— Workers 不保证请求落在同一实例;
//   ③ 页面刷新后凭本地 taskId 恢复轮询(PRD AI 边界 1)免费获得。
// 代价:cancel 无法改写既定时间表 —— 取消语义由路由层承接(账务返还 + 客户端停止轮询),
// mock 侧为「无资源可释放」的 no-op;T13a 核实:Tripo 公开 API 亦无取消端点,真实引擎同为 no-op,
// 「取消」在两个引擎下语义一致 = 路由层返还 + 客户端停轮询(真实引擎的上游任务会跑完并消耗 credit)。
//
// 失败注入(排期原则 3「mock 引擎先行」的核心价值):prompt 内嵌指令,
// 让 T12 开发与演示在零 credit 成本下确定性地遍历 AI-05 失败三分类:
//   @mock:fail=timeout|moderation|service   注入结局(缺省 = 成功,或按 MOCK_FAIL_RATE 随机)
//   @mock:queue=2s / @mock:run=1500ms       覆盖排队/生成时长(裸数字按 ms)
//   @mock:asset=cube|ico|cyl                指定成功结果(缺省按 prompt 哈希稳定选取)
// 三类失败的时间线各有性格(帮 T12 把三出路做成三种真实体验):
//   moderation  排队结束即拒(内容审核在生成前),progress 停在 0;
//   service     生成中途(50%)崩,模拟引擎侧异常;
//   timeout     进度爬到 99 后到点失败,永不 success。

import type { EngineTask, EngineFailReason, GenerateRequest } from './api-types';
import type { Engine } from './engine';

// ---------- 时间表载荷(编码进 taskId) ----------

interface MockSchedule {
  v: 1;
  sid: string; // 服务层账务键(路由层扣减时的 taskId),AI-07 返还用
  t0: number; // 提交时刻(epoch ms)
  q: number; // 排队时长 ms
  r: number; // 生成时长 ms
  o: 'ok' | EngineFailReason; // 结局
  a: number; // 成功结果资产索引
}

const PREFIX = 'mk1_';

const b64url = (s: string): string => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string): string => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
};

export function encodeMockTaskId(sched: MockSchedule): string {
  return PREFIX + b64url(JSON.stringify(sched));
}

export function decodeMockTaskId(taskId: string): MockSchedule | null {
  if (!taskId.startsWith(PREFIX)) return null;
  try {
    const j = JSON.parse(unb64url(taskId.slice(PREFIX.length))) as MockSchedule;
    if (j.v !== 1 || typeof j.sid !== 'string' || typeof j.t0 !== 'number') return null;
    return j;
  } catch {
    return null;
  }
}

// ---------- 指令解析 ----------

export interface MockDirectives {
  fail?: EngineFailReason;
  queueMs?: number;
  runMs?: number;
  asset?: number;
}

const ASSET_FILES = ['cube', 'ico', 'cyl'] as const;
const FAIL_REASONS: EngineFailReason[] = ['timeout', 'moderation', 'service'];

const parseDuration = (raw: string): number | undefined => {
  const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === 's' ? n * 1000 : n;
};

export function parseMockDirectives(prompt: string): MockDirectives {
  const out: MockDirectives = {};
  for (const m of prompt.matchAll(/@mock:(fail|queue|run|asset)=([a-z0-9.]+)/gi)) {
    const key = m[1].toLowerCase();
    const val = m[2].toLowerCase();
    if (key === 'fail' && (FAIL_REASONS as string[]).includes(val)) out.fail = val as EngineFailReason;
    if (key === 'queue') out.queueMs = parseDuration(val);
    if (key === 'run') out.runMs = parseDuration(val);
    if (key === 'asset') {
      const idx = (ASSET_FILES as readonly string[]).indexOf(val);
      if (idx >= 0) out.asset = idx;
    }
  }
  return out;
}

/** FNV-1a:prompt → 稳定的资产选取(同 prompt 恒得同结果,便于演示复现) */
const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

export const mockResultUrl = (assetIdx: number): string => `/mock/${ASSET_FILES[assetIdx % ASSET_FILES.length]}.glb`;

// ---------- 引擎实现 ----------

export interface MockEngineOpts {
  queueMs?: number; // 默认排队时长(wrangler MOCK_QUEUE_MS)
  runMs?: number; // 默认生成时长(wrangler MOCK_RUN_MS)
  failRate?: number; // 0–1 随机失败率(wrangler MOCK_FAIL_RATE;指令注入优先)
  now?: () => number; // 测试注入时钟
  rand?: () => number; // 测试注入随机源
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class MockEngine implements Engine {
  readonly name = 'mock';
  private readonly queueMs: number;
  private readonly runMs: number;
  private readonly failRate: number;
  private readonly now: () => number;
  private readonly rand: () => number;

  constructor(opts: MockEngineOpts = {}) {
    this.queueMs = opts.queueMs ?? 4000;
    this.runMs = opts.runMs ?? 10000;
    this.failRate = clamp(opts.failRate ?? 0, 0, 1);
    this.now = opts.now ?? Date.now;
    this.rand = opts.rand ?? Math.random;
  }

  async submit(req: GenerateRequest, serviceTaskId: string, _ownKey?: string): Promise<EngineTask> {
    const prompt = req.prompt ?? '';
    const d = parseMockDirectives(prompt);
    const outcome: MockSchedule['o'] =
      d.fail ?? (this.failRate > 0 && this.rand() < this.failRate ? FAIL_REASONS[Math.floor(this.rand() * 3) % 3] : 'ok');
    const sched: MockSchedule = {
      v: 1,
      sid: serviceTaskId,
      t0: this.now(),
      q: Math.max(0, d.queueMs ?? this.queueMs),
      r: Math.max(1, d.runMs ?? this.runMs),
      o: outcome,
      a: d.asset ?? fnv1a(prompt) % ASSET_FILES.length,
    };
    return this.snapshot(sched, encodeMockTaskId(sched));
  }

  async query(taskId: string, _ownKey?: string): Promise<EngineTask> {
    const sched = decodeMockTaskId(taskId);
    if (!sched) {
      // 无法识别的任务 = 引擎侧 404/过期,按 timeout 类处理(技术方案 §4 /api/task 失败语义)
      return { taskId, status: 'failed', progress: 0, failReason: 'timeout' };
    }
    return this.snapshot(sched, taskId);
  }

  async cancel(_taskId: string, _ownKey?: string): Promise<void> {
    // mock 无上游资源可释放;账务返还由路由层执行(AI-07「取消还」),客户端随即停止轮询。
  }

  async billingIdOf(taskId: string): Promise<string | null> {
    return decodeMockTaskId(taskId)?.sid ?? null;
  }

  /** 时间表 → 当前状态(纯函数式推导,任何实例任何时刻结论一致) */
  private snapshot(s: MockSchedule, taskId: string): EngineTask {
    const t = this.now();
    const queueEnd = s.t0 + s.q;
    const runEnd = queueEnd + s.r;

    if (t < queueEnd) {
      // 排队位置反馈(PRD AI-03):按剩余排队时间折算,mock 侧的可信假数
      const queuePosition = Math.max(1, Math.ceil((queueEnd - t) / 2000));
      return { taskId, status: 'queued', progress: 0, queuePosition };
    }
    if (s.o === 'moderation') {
      return { taskId, status: 'failed', progress: 0, failReason: 'moderation' };
    }
    if (s.o === 'service' && t >= queueEnd + s.r / 2) {
      return { taskId, status: 'failed', progress: 50, failReason: 'service' };
    }
    if (t < runEnd) {
      const progress = clamp(Math.floor(((t - queueEnd) / s.r) * 100), 1, 99);
      return { taskId, status: 'running', progress };
    }
    if (s.o === 'timeout') {
      return { taskId, status: 'failed', progress: 99, failReason: 'timeout' };
    }
    return { taskId, status: 'success', progress: 100, resultUrl: mockResultUrl(s.a) };
  }
}
