// T12 · AI 指令条(PRD AI-01/03/04/05/06/08 + AI-07/11 的前端侧 + AI 边界 1)。
// 布局:底部横条,左"输入区"右"状态区",全生命周期不弹窗、不遮视口——AI 嵌于工作流(AI-01)。
// 与服务层的全部往来走 worker/api-types 协议;不感知具体引擎(AI-10),T13 换 Tripo 零改动。
// 「接受」将结果 GLB 送入 T10 导入管线(解析→单位→水密预检→贴床);
// 完整 AI-09 落入链(自动选中+聚焦+首检+R2 转存)随 T16 收口。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError, CancelResponse, GenerateResponse, QuotaResponse, TaskResponse } from '../../worker/api-types';
import { startImport } from '../importer/ingest';
import { apiHeaders, getEngineKey, setEngineKey } from '../net/visitor';
import { useUi } from '../state/store';
import {
  ACTIVE_TASK_KEY,
  applyTask,
  emptyContext,
  idleState,
  inputLockedIn,
  onSubmitted,
  outletOf,
  parseActiveTicket,
  pollDelayOf,
  PROMPT_MAX_CHARS,
  resultFileName,
  resumeState,
  serializeActive,
  validateText,
  type GenContext,
  type GenState,
} from './gen-logic';
import { mountTurnstile, usingTestSiteKey, type TurnstileHandle } from './turnstile';

// ---------- 样式 ----------

const shell: React.CSSProperties = {
  flex: '0 0 380px',
  border: '1px solid #2b2b31',
  background: '#1b1b20',
  borderRadius: 8,
  padding: '8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minHeight: 0,
  position: 'relative',
  fontSize: 12,
  color: '#c9c9cf',
};

const inputRow: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'stretch', minHeight: 0, flex: 1 };

const ta: React.CSSProperties = {
  flex: 1,
  resize: 'none',
  background: '#232329',
  border: '1px solid #34343c',
  borderRadius: 6,
  color: '#e8e8ea',
  fontSize: 12,
  lineHeight: 1.5,
  padding: '5px 8px',
  outline: 'none',
  fontFamily: 'inherit',
};

const btn: React.CSSProperties = {
  background: '#2a2a31',
  border: '1px solid #3d3d46',
  borderRadius: 6,
  color: '#c9c9cf',
  fontSize: 12,
  padding: '4px 10px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const primaryBtn: React.CSSProperties = { ...btn, background: '#2d4a2f', border: '1px solid #3f6b42', color: '#d9f0da' };
const dangerBtn: React.CSSProperties = { ...btn, background: '#4a2d2d', border: '1px solid #6b3f3f', color: '#f0d9d9' };
const dim: React.CSSProperties = { color: '#8b8b93' };
const statusRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 22 };

const barTrack: React.CSSProperties = { flex: 1, height: 6, background: '#2a2a31', borderRadius: 3, overflow: 'hidden' };
const barFill = (pct: number, color: string): React.CSSProperties => ({
  width: `${Math.max(0, Math.min(100, pct))}%`,
  height: '100%',
  background: color,
  transition: 'width 0.4s ease',
});

// ---------- 组件 ----------

export function GenPanel() {
  const [gen, setGen] = useState<GenState>(() => idleState());
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [promptMax, setPromptMax] = useState(PROMPT_MAX_CHARS); // T13a-fix1:随 /api/health 的引擎上报值收紧(Tripo=1024)
  const promptMaxRef = useRef(PROMPT_MAX_CHARS);
  const [waitingToken, setWaitingToken] = useState(false); // 已点提交、等 widget 出 token
  const [tsBroken, setTsBroken] = useState(false); // 脚本装载失败/错误回调
  const [ownKeyOpen, setOwnKeyOpen] = useState(false);
  const [ownKeyDraft, setOwnKeyDraft] = useState('');
  const [hasOwnKey, setHasOwnKey] = useState(false);

  const genRef = useRef(gen);
  genRef.current = gen;
  const tsRef = useRef<TurnstileHandle | null>(null);
  const tsMount = useRef<HTMLDivElement | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingSubmit = useRef(false); // token 就绪后自动续提交(重试出路 / 首次验证慢)

  // ---- 状态更新统一入口:同步维护刷新恢复票据(AI 边界 1)----
  const commit = useCallback((next: GenState) => {
    setGen(next);
    genRef.current = next;
    try {
      const raw = serializeActive(next);
      if (raw) localStorage.setItem(ACTIVE_TASK_KEY, raw);
      else localStorage.removeItem(ACTIVE_TASK_KEY);
    } catch {
      /* 无 storage:刷新恢复退化,不阻断主流程 */
    }
  }, []);

  // ---- 配额 ----
  const refreshQuota = useCallback(async () => {
    try {
      const r = await fetch('/api/quota', { headers: apiHeaders() });
      setQuota(r.ok ? ((await r.json()) as QuotaResponse) : null);
    } catch {
      setQuota(null);
    }
  }, []);

  // ---- 轮询(AI-04:排队 5s / 生成 2s)----
  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const pollOnce = useCallback(
    async (taskId: string) => {
      const cur = genRef.current;
      if (cur.taskId !== taskId || (cur.phase !== 'queued' && cur.phase !== 'running')) return;
      let next = cur;
      try {
        const r = await fetch(`/api/task/${encodeURIComponent(taskId)}`, { headers: apiHeaders() });
        const j = (await r.json()) as TaskResponse | ApiError;
        if (j.ok) next = applyTask(cur, j.task, (j as TaskResponse).refunded);
        // 服务侧瞬时错误(engine_query_failed 等):保持当前态,下一拍重试——轮询天然容错
      } catch {
        /* 网络抖动:同上,静默等下一拍;持续断网最终由服务端 timeout 语义收尾 */
      }
      commit(next);
      if (next.phase === 'queued' || next.phase === 'running') {
        pollTimer.current = setTimeout(() => void pollOnce(taskId), pollDelayOf(next.phase));
      } else {
        void refreshQuota(); // 终态后复查配额(返还/计费的权威读数)
      }
    },
    [commit, refreshQuota],
  );

  const startPolling = useCallback(
    (state: GenState) => {
      stopPolling();
      if ((state.phase === 'queued' || state.phase === 'running') && state.taskId) {
        pollTimer.current = setTimeout(() => void pollOnce(state.taskId as string), pollDelayOf(state.phase));
      }
    },
    [pollOnce, stopPolling],
  );

  // ---- 提交(AI-01 校验在前;token 单次使用)----
  const doSubmit = useCallback(
    async (context: GenContext) => {
      const v = validateText(context.prompt, promptMaxRef.current);
      if (!v.ok) {
        commit(idleState(context, v.message));
        return;
      }
      const token = tsRef.current?.consume() ?? null;
      if (!token) {
        pendingSubmit.current = true; // token 就绪回调里续提交
        setWaitingToken(true);
        tsRef.current?.reset();
        return;
      }
      setWaitingToken(false);
      commit({ ...idleState(context), phase: 'submitting' });
      try {
        const r = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...apiHeaders() },
          body: JSON.stringify({ type: context.type, prompt: context.prompt.trim(), turnstileToken: token }),
        });
        const j = (await r.json()) as GenerateResponse | ApiError;
        if (!j.ok) {
          const e = j as ApiError;
          if (e.class === 'turnstile') {
            tsRef.current?.reset();
            commit(idleState(context, '人机验证未通过,请重新提交。'));
          } else if (e.class === 'quota') {
            await refreshQuota(); // 拦截读数交给配额区呈现(AI-07/11)
            commit(idleState(context, e.message));
          } else {
            // validation(服务侧镜像)/ service(提交即失败,已按 AI-07 返还)/ not_implemented
            const suffix = e.refunded ? '(本次扣减已返还)' : '';
            commit(idleState(context, `${e.message}${suffix}`));
            void refreshQuota();
          }
          return;
        }
        const next = onSubmitted(context, j, Date.now());
        commit(next);
        void refreshQuota(); // 提交扣(AI-07)后的即时读数
        startPolling(next);
      } catch {
        commit(idleState(context, '提交失败:网络不可达,请检查连接后重试(未产生扣减则无需返还)。'));
      }
    },
    [commit, refreshQuota, startPolling],
  );

  // ---- 取消(AI-06:排队与生成阶段均可)----
  const doCancel = useCallback(async () => {
    const cur = genRef.current;
    if (!cur.taskId || (cur.phase !== 'queued' && cur.phase !== 'running')) return;
    stopPolling();
    let refunded = false;
    try {
      const r = await fetch(`/api/task/${encodeURIComponent(cur.taskId)}/cancel`, {
        method: 'POST',
        headers: apiHeaders(),
      });
      const j = (await r.json()) as CancelResponse | ApiError;
      if (j.ok) refunded = (j as CancelResponse).refunded;
    } catch {
      /* 取消请求失败:客户端仍停止轮询;返还状态以配额复查为准 */
    }
    commit({ ...cur, phase: 'canceled', refunded });
    void refreshQuota();
  }, [commit, refreshQuota, stopPolling]);

  // ---- 预览确认三键(AI-03 / AI-08 / AI-07)----
  const doAccept = useCallback(async () => {
    const cur = genRef.current;
    if (cur.phase !== 'success' || !cur.resultUrl) return;
    try {
      // T13a:结果经服务层代理(/api/task/:id/result),自带 key 通道靠 x-engine-key 头鉴权上游;
      // mock 的同源静态结果对多余头不敏感——同一行代码覆盖两个引擎。
      const r = await fetch(cur.resultUrl, { headers: apiHeaders() });
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      const file = new File([blob], resultFileName(cur.context.prompt), { type: 'model/gltf-binary' });
      startImport([file], 'viewport');
      useUi.getState().setToast('AI 结果已进入导入管线(自动选中/聚焦/首检随 T16 落位)');
      commit(idleState());
    } catch {
      commit({ ...cur, notice: '结果下载失败,请重试「接受」或稍后再试(链接仍有效)。' });
    }
  }, [commit]);

  const doAdjust = useCallback(() => {
    // AI-08:完整上下文回填,仅改差异。上下文从未离开输入区数据结构,回填即切回 idle。
    const cur = genRef.current;
    commit(idleState(cur.context, '已回填原始输入,修改后重新提交(重新生成将计一次配额)。'));
    setTimeout(() => taRef.current?.focus(), 0);
  }, [commit]);

  const doDiscard = useCallback(() => {
    commit(idleState(emptyContext(), '已丢弃。成功任务的配额不返还(成本归因:丢弃是用户选择)。'));
  }, [commit]);

  // ---- 失败出路(AI-05)----
  const onFailOutlet = useCallback(() => {
    const cur = genRef.current;
    if (cur.phase !== 'failed' || !cur.failReason) return;
    const { action } = outletOf(cur.failReason);
    if (action === 'retry') {
      void doSubmit(cur.context); // 超时→重试:原上下文原样重发(新 token 自动获取)
    } else if (action === 'edit') {
      commit(idleState(cur.context, '请修改描述后重新提交(原输入已保留)。')); // 审核→修改输入
      setTimeout(() => taRef.current?.focus(), 0);
    } else {
      commit(idleState(cur.context)); // 服务异常→稍后再试:退回输入区,上下文保留
    }
  }, [commit, doSubmit]);

  // ---- 装载:Turnstile 接线 + 刷新恢复 + 配额首读 ----
  useEffect(() => {
    setHasOwnKey(Boolean(getEngineKey()));
    void refreshQuota();

    // T13a-fix1:prompt 上限以引擎上报为准;失败保持兜底 2000(服务端仍会二次校验)
    void (async () => {
      try {
        const h = await fetch('/api/health');
        const hj = (await h.json()) as { config?: { promptMax?: number } };
        const m = hj?.config?.promptMax;
        if (typeof m === 'number' && m > 0) {
          setPromptMax(m);
          promptMaxRef.current = m;
        }
      } catch {
        /* 离线/失败:保持兜底 */
      }
    })();

    // AI 边界 1:存在活动票据 → 恢复轮询(服务端无状态时间表保证未知/过期稳定收敛到 timeout+返还)
    try {
      const ticket = parseActiveTicket(localStorage.getItem(ACTIVE_TASK_KEY));
      if (ticket) {
        const resumed = resumeState(ticket);
        commit(resumed);
        void pollOnce(ticket.taskId); // 立即问一拍,快速校正到真实状态
      }
    } catch {
      /* 无 storage:无票据可恢复 */
    }

    let disposed = false;
    if (tsMount.current) {
      void mountTurnstile(
        tsMount.current,
        () => {
          if (disposed) return;
          setTsBroken(false);
          if (pendingSubmit.current) {
            pendingSubmit.current = false;
            setWaitingToken(false);
            void doSubmit(genRef.current.context);
          }
        },
        () => !disposed && setTsBroken(true),
      ).then((h) => {
        if (disposed) h.destroy();
        else tsRef.current = h;
      });
    }
    return () => {
      disposed = true;
      stopPolling();
      tsRef.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 派生读数 ----
  const remaining = quota?.visitor.remaining ?? null;
  const breakerOpen = quota?.breaker.open ?? false;
  const blocked = !hasOwnKey && (breakerOpen || remaining === 0); // 提交前拦截(AI-07:不进入扣减)
  const p = gen.context.prompt;
  const overLimit = p.trim().length > promptMax;

  const saveOwnKey = () => {
    setEngineKey(ownKeyDraft || null);
    setHasOwnKey(Boolean(ownKeyDraft.trim()));
    setOwnKeyOpen(false);
    setOwnKeyDraft('');
    void refreshQuota();
  };

  // ---- 状态区渲染 ----
  const renderStatus = () => {
    switch (gen.phase) {
      case 'submitting':
        return <span style={dim}>提交中…</span>;
      case 'queued':
        return (
          <>
            <span>
              排队中{gen.queuePosition !== undefined ? `(位置 ${gen.queuePosition})` : ''}
            </span>
            <div style={barTrack}>
              <div style={barFill(8, '#5a5a8f')} />
            </div>
            <button style={btn} onClick={() => void doCancel()}>
              取消
            </button>
          </>
        );
      case 'running':
        return (
          <>
            <span>生成中 {gen.progress}%</span>
            <div style={barTrack}>
              <div style={barFill(gen.progress, '#4a7c4e')} />
            </div>
            <button style={btn} onClick={() => void doCancel()}>
              取消
            </button>
          </>
        );
      case 'success':
        return (
          <>
            <span style={{ color: '#a8d5ab' }}>✓ 生成完成</span>
            {gen.resultUrl && (
              <a href={gen.resultUrl} target="_blank" rel="noreferrer" style={{ ...dim, textDecoration: 'underline' }}>
                查看 GLB
              </a>
            )}
            <span style={{ flex: 1 }} />
            <button style={primaryBtn} onClick={() => void doAccept()}>
              接受
            </button>
            <button style={btn} onClick={doAdjust}>
              调整
            </button>
            <button style={btn} onClick={doDiscard}>
              丢弃
            </button>
          </>
        );
      case 'failed': {
        const o = outletOf(gen.failReason ?? 'timeout');
        return (
          <>
            <span style={{ color: '#e0a8a8' }}>
              ✕ {o.label}:{o.message}
              {gen.refunded !== false ? ' 配额已返还。' : ''}
            </span>
            <span style={{ flex: 1 }} />
            <button style={o.action === 'retry' ? primaryBtn : btn} onClick={onFailOutlet}>
              {o.outlet}
            </button>
          </>
        );
      }
      case 'canceled':
        return (
          <>
            <span style={dim}>已取消{gen.refunded ? ',配额已返还(AI-07)' : ''}</span>
            <span style={{ flex: 1 }} />
            <button style={btn} onClick={() => commit(idleState(gen.context))}>
              返回输入
            </button>
          </>
        );
      default: {
        // idle:配额芯片 / 拦截出路 / 一次性提示
        if (blocked) {
          return (
            <>
              <span style={{ color: '#e0c9a8' }}>
                {breakerOpen ? '今日站点生成额度已用完' : '今日生成配额已用完'} · 明日再来,或
              </span>
              <button style={btn} onClick={() => setOwnKeyOpen(true)}>
                使用自带 API key
              </button>
            </>
          );
        }
        return (
          <>
            <span style={dim}>
              {quota ? `配额 ${quota.visitor.remaining}/${quota.visitor.limit}` : '配额 —'}
              {hasOwnKey ? ' · 自带 key' : ''}
              {quota?.demo === 'active' ? ' · 演示码' : ''}
            </span>
            {hasOwnKey && (
              <button
                style={{ ...btn, padding: '2px 6px' }}
                title="清除自带 key(仅存于本会话)"
                onClick={() => {
                  setEngineKey(null);
                  setHasOwnKey(false);
                  void refreshQuota();
                }}
              >
                清除
              </button>
            )}
            {gen.notice && <span style={{ color: '#c9b98a', flex: 1, minWidth: 0 }}>{gen.notice}</span>}
            {waitingToken && <span style={dim}>人机验证中…</span>}
            {tsBroken && <span style={{ color: '#e0a8a8' }}>验证组件加载失败,请刷新重试</span>}
          </>
        );
      }
    }
  };

  const inputLocked = inputLockedIn(gen.phase); // 失败/取消态不锁:直接编辑即回到输入态

  return (
    <div style={shell} data-testid="gen-panel">
      <div style={inputRow}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'center' }}>
          <button
            style={{ ...btn, padding: '2px 8px', ...(gen.context.type === 'text' ? { borderColor: '#5a8f5e', color: '#d9f0da' } : {}) }}
            disabled={inputLocked}
            onClick={() => commit(idleState({ ...gen.context, type: 'text' }))}
          >
            文生
          </button>
          <button
            style={{ ...btn, padding: '2px 8px', opacity: 0.45, cursor: 'not-allowed' }}
            disabled
            title="图生引擎通道随 T13 接线(前端校验规则已入档)"
          >
            图生
          </button>
        </div>
        <textarea
          ref={taRef}
          style={{ ...ta, ...(overLimit ? { borderColor: '#8f5a5a' } : {}) }}
          placeholder="描述想生成的 3D 模型…(mock 引擎在线;@mock: 指令可注入演练场景)"
          value={p}
          disabled={inputLocked}
          onChange={(e) => commit(idleState({ ...gen.context, prompt: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !inputLocked && !blocked) {
              e.preventDefault();
              void doSubmit(gen.context);
            }
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'center', alignItems: 'flex-end' }}>
          <button
            style={{ ...primaryBtn, ...(inputLocked || blocked || overLimit ? { opacity: 0.5, cursor: 'default' } : {}) }}
            disabled={inputLocked || blocked || overLimit}
            onClick={() => void doSubmit(gen.context)}
          >
            生成
          </button>
          <span style={{ ...dim, fontSize: 10, ...(overLimit ? { color: '#e0a8a8' } : {}) }}>
            {p.trim().length}/{promptMax}
          </span>
        </div>
      </div>
      <div style={statusRow}>{renderStatus()}</div>
      {/* Turnstile 挂载点:interaction-only,无感通过时不可见;需要交互时在条内浮现 */}
      <div ref={tsMount} style={{ position: 'absolute', bottom: 30, left: 10, zIndex: 40 }} />
      {ownKeyOpen && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 8,
            width: 340,
            background: '#1f1f25',
            border: '1px solid #34343c',
            borderRadius: 10,
            padding: '12px 14px',
            zIndex: 60,
            boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
          }}
        >
          <div style={{ marginBottom: 6 }}>自带 Tripo API key(AI-11)</div>
          <div style={{ ...dim, marginBottom: 8, lineHeight: 1.6 }}>
            仅保存在本浏览器会话(sessionStorage),随请求透传,服务层不落盘;关闭标签页即失效。成本计入你的 key。
          </div>
          <input
            style={{ ...ta, width: '100%', boxSizing: 'border-box', marginBottom: 8 }}
            type="password"
            placeholder="tcli_…"
            value={ownKeyDraft}
            onChange={(e) => setOwnKeyDraft(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button style={btn} onClick={() => setOwnKeyOpen(false)}>
              取消
            </button>
            <button style={primaryBtn} disabled={!ownKeyDraft.trim()} onClick={saveOwnKey}>
              保存
            </button>
          </div>
        </div>
      )}
      {!usingTestSiteKey() ? null : null /* 测试 site key 提示只进 README,不占 UI */}
    </div>
  );
}
