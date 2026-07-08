// T3:顶栏服务层状态芯片 + 诊断面板。
// 定位:开发/验收期的服务层可视化探针——不用 curl 也能在浏览器里点测 T3 全链路
// (健康 → 配额 → 生成演练的「扣减→返还」对账)。T12 指令条落位后此面板保留为诊断入口。
import { useCallback, useEffect, useState } from 'react';
import type { ApiError, HealthResponse, QuotaResponse } from '../../worker/api-types';
import { apiHeaders, captureDemoCode, getClientId } from './visitor';

type HealthState = '检测中' | '在线' | '离线';

interface DiagLine {
  icon: '✅' | '⚠️' | '❌' | '·';
  text: string;
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
  const [running, setRunning] = useState(false);

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

  // 生成链路演练:dummy token 提交一次文生。三种结局都算「链路给出正确裁决」:
  // 测试 secret → 扣减+返还全走通;真实 secret → Turnstile 拒 dummy(校验生效);未配 secret → 提示去配置。
  const runDrill = useCallback(async () => {
    setRunning(true);
    const lines: DiagLine[] = [];
    const before = quota?.visitor.remaining;
    lines.push({ icon: '·', text: `提交演练请求(dummy token,type=text)…` });
    setDiag([...lines]);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ type: 'text', prompt: '服务层诊断演练', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
      });
      const j = (await res.json()) as ApiError | { ok: true };
      if ('ok' in j && j.ok) {
        lines.push({ icon: '⚠️', text: '引擎返回了任务?T3 阶段不应发生,请反馈。' });
      } else {
        const e = j as ApiError;
        if (e.error === 'engine_unavailable') {
          lines.push({
            icon: '✅',
            text: `Turnstile 通过 → 配额扣减 → 引擎未接入(T4)→ ${e.refunded ? '已返还 ✅(AI-07)' : '自带 key 通道,无扣减'}`,
          });
          const q2 = await fetch('/api/quota', { headers: apiHeaders() });
          if (q2.ok) {
            const qj = (await q2.json()) as QuotaResponse;
            setQuota(qj);
            if (before !== undefined) {
              lines.push({
                icon: qj.visitor.remaining === before ? '✅' : '⚠️',
                text: `配额复查:演练前 ${before} → 演练后 ${qj.visitor.remaining}(应相等,返还幂等)`,
              });
            }
          }
        } else if (e.error === 'turnstile_failed') {
          lines.push({ icon: '✅', text: '真实 Turnstile secret 生效:dummy token 被拒(widget 随 T12 接线后走真实 token)。' });
        } else if (e.error === 'turnstile_unconfigured') {
          lines.push({ icon: '❌', text: 'TURNSTILE_SECRET_KEY 未配置——按 README「T3 验收」第 0 步设置(可先用测试 secret)。' });
        } else if (e.error === 'quota_exhausted') {
          lines.push({ icon: '⚠️', text: '今日配额已用尽(明日 UTC 翻转,或用演示码/自带 key)。' });
        } else if (e.error === 'budget_exhausted') {
          lines.push({ icon: '⚠️', text: '全局熔断开启:站点今日预算已用完(D6 ③ 降级生效)。' });
        } else {
          lines.push({ icon: '⚠️', text: `${e.error}(${e.class}):${e.message}` });
        }
      }
    } catch {
      lines.push({ icon: '❌', text: '网络错误,服务层不可达。' });
    }
    setDiag([...lines]);
    setRunning(false);
  }, [quota]);

  const color = health === '在线' ? '#5dcaa5' : health === '离线' ? '#f09595' : '#8b8b93';
  const chip = (
    <span style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => setOpen((v) => !v)} title="服务层诊断">
      服务层: <b style={{ color }}>{health}</b>
      {quota && (
        <span style={dim}>
          {' '}· 配额 {quota.visitor.remaining}/{quota.visitor.limit}
          {quota.demo === 'active' && ' · 演示码'}
          {quota.breaker.open && ' · 熔断'}
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
            <b style={{ color: '#e8e8ea' }}>服务层诊断(T3)</b>
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
          <div style={row}><span style={dim}>生成引擎</span><span>{conf?.engine ? '已接入' : '未接入(T4 mock / T13 Tripo)'}</span></div>
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
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button style={btn} onClick={() => void refresh()}>刷新</button>
            <button style={btn} disabled={running} onClick={() => void runDrill()}>
              {running ? '演练中…' : '运行生成链路演练'}
            </button>
          </div>
          {diag.length > 0 && (
            <div style={{ marginTop: 8, borderTop: '1px solid #2f2f37', paddingTop: 6 }}>
              {diag.map((l, i) => (
                <div key={i}>{l.icon} {l.text}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
