// T3/T4:顶栏服务层状态芯片 + 诊断面板。
// 定位:开发/验收期的服务层可视化探针——不用 curl 也能在浏览器里点测服务层全链路。
// T4 起演练升级为真实任务生命周期:提交 → 排队 → 生成中 → 成功/失败,走的就是 T12 将要走的
// /api/generate + /api/task 轮询协议(演练加速为 500ms 轮询;产品级 5s/2s 分频属 T12)。
// 失败链演练用 @mock:fail=service 注入故障 → 观察 AI-05 分类与 AI-07 返还,净配额消耗为零。
import { useCallback, useEffect, useState } from 'react';
import type { ApiError, EngineTask, GenerateResponse, HealthResponse, QuotaResponse, TaskResponse } from '../../worker/api-types';
import { FAIL_REASON_COPY } from '../../worker/api-types';
import { apiHeaders, captureDemoCode, getClientId } from './visitor';

type HealthState = '检测中' | '在线' | '离线';

interface DiagLine {
  icon: '✅' | '⚠️' | '❌' | '·';
  text: string;
  url?: string; // 结果链接(成功链演练的 resultUrl)
}

const card: React.CSSProperties = {
  position: 'fixed',
  top: 52,
  right: 12,
  width: 340,
  zIndex: 60,
  background: '#1f1f25',
  border: '1px solid #34343c',
  borderRadius: 10,
  padding: '12px 14px',
  color: '#c9c9cf',
  fontSize: 12,
  lineHeight: 1.7,
  boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
};

const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8 };
const dim: React.CSSProperties = { color: '#8b8b93' };
const btn: React.CSSProperties = {
  background: '#2a2a31',
  border: '1px solid #3d3d46',
  borderRadius: 6,
  color: '#c9c9cf',
  fontSize: 12,
  padding: '4px 10px',
  cursor: 'pointer',
};

export function ServiceStatus() {
  const [health, setHealth] = useState<HealthState>('检测中');
  const [conf, setConf] = useState<HealthResponse['config'] | null>(null);
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [diag, setDiag] = useState<DiagLine[]>([]);
  const [running, setRunning] = useState<null | 'fail' | 'success'>(null);

  const refresh = useCallback(async () => {
    try {
      const h = await fetch('/api/health');
      if (!h.ok) throw new Error();
      const hj = (await h.json()) as HealthResponse;
      setHealth('在线');
      setConf(hj.config);
    } catch {
      setHealth('离线');
      setConf(null);
    }
    try {
      const q = await fetch('/api/quota', { headers: apiHeaders() });
      setQuota(q.ok ? ((await q.json()) as QuotaResponse) : null);
    } catch {
      setQuota(null);
    }
  }, []);

  useEffect(() => {
    captureDemoCode();
    void refresh();
  }, [refresh]);

  // 生成链路演练(T4):dummy token 提交一次文生并轮询到终态。
  // 失败链(免费):注入 service 故障 → 排队 → 生成中 → 失败(AI-05 分类)→ 返还(AI-07),配额净零;
  // 成功链(耗 1 次):走到 success 拿 resultUrl —— 成功计费属用户选择,不返还(AI-07)。
  // 若 ENGINE_MODE 未配 / Turnstile 用真实 secret,则按 T3 的旧结局归类,同样算链路裁决正确。
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const runDrill = useCallback(
    async (kind: 'fail' | 'success') => {
      // T13a:演练是 mock 通道的专属工具 —— @mock 故障注入真实引擎不识别(提交前会被剥离),
      // 且演练的 20 秒收敛窗对真实生成(分钟级)必然超时,白白消耗真实 credits。
      // 真实引擎的链路验收走生成面板主链(README「T13a 验收」)。按钮已禁用,此处兜底。
      if (conf?.engine && conf.engineName !== 'mock') {
        setDiag([{ icon: '⚠️', text: '当前为真实引擎,演练已停用(会消耗真实 credits 且必然超时)。请走生成面板主链验收。' }]);
        return;
      }
      setRunning(kind);
      const lines: DiagLine[] = [];
      const push = (l: DiagLine) => {
        lines.push(l);
        setDiag([...lines]);
      };
      const before = quota?.visitor.remaining;
      const inject = kind === 'fail' ? ' @mock:fail=service' : '';
      push({
        icon: '·',
        text: kind === 'fail' ? '失败链演练:提交注入 service 故障的任务…' : '成功链演练:提交任务(将消耗 1 次配额)…',
      });
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...apiHeaders() },
          body: JSON.stringify({
            type: 'text',
            prompt: `服务层诊断演练${inject} @mock:queue=1s @mock:run=2s`,
            turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
          }),
        });
        const j = (await res.json()) as GenerateResponse | ApiError;
        if (!j.ok) {
          const e = j as ApiError;
          if (e.error === 'engine_unavailable') {
            push({
              icon: '✅',
              text: `引擎未接入(ENGINE_MODE 未配)→ 走 T3 返还链:${e.refunded ? '已返还 ✅(AI-07)' : '自带 key 通道,无扣减'}`,
            });
          } else if (e.error === 'turnstile_failed') {
            push({ icon: '✅', text: '真实 Turnstile secret 生效:dummy token 被拒(widget 随 T12 接线后走真实 token)。' });
          } else if (e.error === 'turnstile_unconfigured') {
            push({ icon: '❌', text: 'TURNSTILE_SECRET_KEY 未配置——按 README「T3 验收」第 0 步设置(可先用测试 secret)。' });
          } else if (e.error === 'quota_exhausted') {
            push({ icon: '⚠️', text: '今日配额已用尽(明日 UTC 翻转,或用演示码/自带 key)。' });
          } else if (e.error === 'budget_exhausted') {
            push({ icon: '⚠️', text: '全局熔断开启:站点今日预算已用完(D6 ③ 降级生效)。' });
          } else {
            push({ icon: '⚠️', text: `${e.error}(${e.class}):${e.message}` });
          }
          setRunning(null);
          return;
        }
        push({ icon: '✅', text: `提交成功(engine=${j.engine}),配额已按「提交扣」记账` });
        let task: EngineTask = j.task;
        let refundSeen = false;
        let loggedQueue = false;
        let loggedRun = false;
        for (let i = 0; i < 40 && task.status !== 'success' && task.status !== 'failed'; i++) {
          if (task.status === 'queued' && !loggedQueue) {
            loggedQueue = true;
            push({ icon: '·', text: `排队中(位置 ${task.queuePosition ?? '—'})…` });
          }
          if (task.status === 'running' && !loggedRun) {
            loggedRun = true;
            push({ icon: '·', text: `生成中(进度 ${task.progress}%)…` });
          }
          await sleep(500);
          const r = await fetch(`/api/task/${encodeURIComponent(task.taskId)}`, { headers: apiHeaders() });
          const tj = (await r.json()) as TaskResponse | ApiError;
          if (!tj.ok) {
            push({ icon: '⚠️', text: `任务查询异常:${(tj as ApiError).message}` });
            setRunning(null);
            return;
          }
          task = tj.task;
          if (tj.refunded) refundSeen = true;
        }
        if (task.status === 'success') {
          push({ icon: kind === 'success' ? '✅' : '⚠️', text: '生成成功(100%),结果:', url: task.resultUrl });
        } else if (task.status === 'failed') {
          const copy = FAIL_REASON_COPY[task.failReason ?? 'service'];
          push({
            icon: kind === 'fail' ? '✅' : '❌',
            text: `失败分类 = ${task.failReason}(${copy.label},出路:${copy.outlet})→ 服务层返还${refundSeen ? '已执行 ✅' : '(早前轮询已执行)'}`,
          });
        } else {
          push({ icon: '⚠️', text: '演练超时未收敛,请重试。' });
        }
        // 配额复查:失败链应相等(返还),成功链应减 1(成功计费)
        const q2 = await fetch('/api/quota', { headers: apiHeaders() });
        if (q2.ok) {
          const qj = (await q2.json()) as QuotaResponse;
          setQuota(qj);
          if (before !== undefined) {
            const pass = kind === 'fail' ? qj.visitor.remaining === before : qj.visitor.remaining === before - 1;
            push({
              icon: pass ? '✅' : '⚠️',
              text: `配额复查:演练前 ${before} → 演练后 ${qj.visitor.remaining}(${
                kind === 'fail' ? '应相等:失败返还' : '应减 1:成功计费'
              },AI-07)`,
            });
          }
        }
      } catch {
        push({ icon: '❌', text: '网络错误,服务层不可达。' });
      }
      setRunning(null);
    },
    [quota, conf],
  );

  const color = health === '在线' ? '#5dcaa5' : health === '离线' ? '#f09595' : '#8b8b93';
  const realEngine = Boolean(conf?.engine) && conf?.engineName !== 'mock'; // T13a:tripo 等真实引擎
  const serviceLabel = health === '检测中'
    ? 'AI 连接中'
    : health === '离线'
      ? 'AI 暂不可用'
      : conf?.engineName === 'mock'
        ? 'AI 演示模式'
        : 'AI 已连接';
  const chip = (
    <span
      className="service-status-chip"
      style={{ cursor: 'pointer', userSelect: 'none' }}
      onClick={() => setOpen((v) => !v)}
      title="查看 AI 服务状态"
    >
      <b style={{ color }}>{serviceLabel}</b>
      {quota && (
        <span style={dim}>
          {' '}· 今日 {quota.visitor.remaining}/{quota.visitor.limit}
          {quota.demo === 'active' && ' · 演示码'}
          {quota.breaker.open && ' · 今日额度已满'}
        </span>
      )}
      <span style={dim}> ▾</span>
    </span>
  );

  return (
    <>
      {chip}
      {open && (
        <div style={card}>
          <div style={{ ...row, marginBottom: 6 }}>
            <b style={{ color: '#e8e8ea' }}>服务层诊断(T3/T4/T13a)</b>
            <span style={{ ...dim, cursor: 'pointer' }} onClick={() => setOpen(false)}>✕</span>
          </div>
          <div style={row}><span style={dim}>访客标识</span><span>{getClientId().slice(0, 8)}…(+IP 复合键)</span></div>
          <div style={row}>
            <span style={dim}>演示码</span>
            <span>{quota?.demo === 'active' ? '生效(URL ?demo=)' : quota?.demo === 'invalid' ? '无效/已撤销' : '未使用'}</span>
          </div>
          <div style={row}>
            <span style={dim}>Turnstile</span>
            <span>{conf ? (conf.turnstile ? '已配置' : '未配置(README T3 第 0 步)') : '—'}</span>
          </div>
          <div style={row}><span style={dim}>生成引擎</span><span>{conf?.engine ? `已接入(${conf.engineName ?? '?'})` : '未接入(ENGINE_MODE 未配)'}</span></div>
          {quota && (
            <>
              <div style={row}>
                <span style={dim}>访客配额</span>
                <span>{quota.visitor.used}/{quota.visitor.limit} 已用 · 日界 {quota.day}(UTC)</span>
              </div>
              <div style={row}>
                <span style={dim}>全局熔断</span>
                <span>{quota.breaker.usedCredits}/{quota.breaker.limitCredits} credits{quota.breaker.open ? ' · 已开' : ''}</span>
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button style={btn} onClick={() => void refresh()}>刷新</button>
            {/* T13a:演练仅 mock 通道提供 —— 真实引擎下禁用(防误耗 credits;主链验收见 README) */}
            <button
              style={btn}
              disabled={running !== null || realEngine}
              title={realEngine ? '真实引擎下停用:@mock 故障注入不生效' : undefined}
              onClick={() => void runDrill('fail')}
            >
              {running === 'fail' ? '演练中…' : '失败链演练(免费)'}
            </button>
            <button
              style={btn}
              disabled={running !== null || realEngine}
              title={realEngine ? '真实引擎下停用:会消耗真实 credits 且演练窗必然超时' : undefined}
              onClick={() => void runDrill('success')}
            >
              {running === 'success' ? '演练中…' : '成功链演练(耗 1 次)'}
            </button>
          </div>
          {realEngine && (
            <div style={{ ...dim, marginTop: 6 }}>
              真实引擎({conf?.engineName})在线:演练停用,链路验收走生成面板主链;成本护栏 = 配额 + 熔断。
            </div>
          )}
          {diag.length > 0 && (
            <div style={{ marginTop: 8, borderTop: '1px solid #2f2f37', paddingTop: 6 }}>
              {diag.map((l, i) => (
                <div key={i}>
                  {l.icon} {l.text}
                  {l.url && (
                    <a href={l.url} target="_blank" rel="noreferrer" style={{ color: '#e8b34b' }}>
                      {l.url}
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
