// T12 · AI 指令条(PRD AI-01/03/04/05/06/08 + AI-07/11 的前端侧 + AI 边界 1)。
// 布局:底部横条,左"输入区"右"状态区",全生命周期不弹窗、不遮视口——AI 嵌于工作流(AI-01)。
// 与服务层的全部往来走 worker/api-types 协议;不感知具体引擎(AI-10),T13 换 Tripo 零改动。
// 「接受」将结果 GLB 送入 T10/T11 同源管线，并由 T16 汇聚点完成
// 资产→实例→选中→聚焦→沉底→首检；R2 转存随 T13b 裁出演示范围。

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApiError,
  CancelResponse,
  GenerateResponse,
  GenerateType,
  ImageView,
  QuotaResponse,
  TaskResponse,
} from '../../worker/api-types';
import { apiHeaders, getEngineKey, setEngineKey } from '../net/visitor';
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
  validateImageFile,
  validateImageSelection,
  type GenContext,
  type GenImageMeta,
  type GenState,
} from './gen-logic';
import { mountTurnstile, usingTestSiteKey, type TurnstileHandle } from './turnstile';
import { startAiLanding } from './landing';

// ---------- 样式 ----------

const shell: React.CSSProperties = {
  flex: '0 1 680px',
  minWidth: 0,
  border: '1px solid #2b2b31',
  background: '#1b1b20',
  borderRadius: 8,
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minHeight: 0,
  position: 'relative',
  fontSize: 12,
  color: '#c9c9cf',
};

const inputRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'stretch', minHeight: 62, flex: 1 };

const ta: React.CSSProperties = {
  flex: 1,
  resize: 'none',
  background: '#232329',
  border: '1px solid #34343c',
  borderRadius: 8,
  color: '#e8e8ea',
  fontSize: 13,
  lineHeight: 1.5,
  padding: '9px 10px',
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

interface SelectedImage {
  view: ImageView;
  file: File;
  previewUrl: string;
}

const MULTIVIEW_SLOTS: Array<{ view: ImageView; label: string; hint: string }> = [
  { view: 'front', label: '正面', hint: '必填' },
  { view: 'left', label: '左侧', hint: '建议' },
  { view: 'right', label: '右侧', hint: '建议' },
];

const imageMeta = (image: SelectedImage): GenImageMeta => ({
  view: image.view,
  name: image.file.name,
  size: image.file.size,
  mime: image.file.type,
});

const fileStem = (name: string): string => name.replace(/\.[^.]+$/, '').trim() || '图片生成模型';

// ---------- 组件 ----------

export function GenPanel() {
  const [gen, setGen] = useState<GenState>(() => idleState());
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [promptMax, setPromptMax] = useState(PROMPT_MAX_CHARS); // T13a-fix1:随 /api/health 的引擎上报值收紧(Tripo=1024)
  const promptMaxRef = useRef(PROMPT_MAX_CHARS);
  const engineNameRef = useRef<string | null>(null);
  const [waitingToken, setWaitingToken] = useState(false); // 已点提交、等 widget 出 token
  const [tsBroken, setTsBroken] = useState(false); // 脚本装载失败/错误回调
  const [ownKeyOpen, setOwnKeyOpen] = useState(false);
  const [ownKeyDraft, setOwnKeyDraft] = useState('');
  const [hasOwnKey, setHasOwnKey] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const [selectedImages, setSelectedImages] = useState<SelectedImage[]>([]);

  const genRef = useRef(gen);
  genRef.current = gen;
  const selectedImagesRef = useRef(selectedImages);
  selectedImagesRef.current = selectedImages;
  const tsRef = useRef<TurnstileHandle | null>(null);
  const tsMount = useRef<HTMLDivElement | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingSubmit = useRef(false); // token 就绪后自动续提交(重试出路 / 首次验证慢)
  const acceptingRef = useRef(false); // 防成功态「接受」双击生成重复资产/实例

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

  const syncSelectedImages = useCallback(
    (next: SelectedImage[], notice?: string) => {
      const keepUrls = new Set(next.map((image) => image.previewUrl));
      for (const image of selectedImagesRef.current) {
        if (!keepUrls.has(image.previewUrl)) URL.revokeObjectURL(image.previewUrl);
      }
      selectedImagesRef.current = next;
      setSelectedImages(next);
      const current = genRef.current.context;
      const front = next.find((image) => image.view === 'front');
      commit(
        idleState(
          {
            ...current,
            prompt: front ? fileStem(front.file.name) : '',
            images: next.map(imageMeta),
          },
          notice,
        ),
      );
    },
    [commit],
  );

  const clearSelectedImages = useCallback(() => syncSelectedImages([]), [syncSelectedImages]);

  const assignImages = useCallback(
    (startView: ImageView, files: File[]) => {
      const mode = genRef.current.context.type;
      if (mode === 'text' || files.length === 0) return;
      const allowed = mode === 'image' ? (['front'] as ImageView[]) : MULTIVIEW_SLOTS.map((slot) => slot.view);
      const start = Math.max(0, allowed.indexOf(startView));
      const incoming = files.slice(0, allowed.length - start);
      for (const file of incoming) {
        const validation = validateImageFile(file.name, file.size);
        if (!validation.ok) {
          commit(idleState(genRef.current.context, validation.message));
          return;
        }
      }
      const replacements = new Map<ImageView, SelectedImage>();
      incoming.forEach((file, index) => {
        replacements.set(allowed[start + index], {
          view: allowed[start + index],
          file,
          previewUrl: URL.createObjectURL(file),
        });
      });
      const next = selectedImagesRef.current.filter((image) => !replacements.has(image.view));
      next.push(...replacements.values());
      next.sort((a, b) => allowed.indexOf(a.view) - allowed.indexOf(b.view));
      syncSelectedImages(next);
    },
    [commit, syncSelectedImages],
  );

  const switchMode = useCallback(
    (type: GenerateType) => {
      if (inputLockedIn(genRef.current.phase) || genRef.current.context.type === type) return;
      if (type === 'text') {
        clearSelectedImages();
        commit(idleState({ type, prompt: textDraft, images: [] }));
        return;
      }
      const front = selectedImagesRef.current.find((image) => image.view === 'front');
      const next = front ? [front] : [];
      if (type === 'multiview' && genRef.current.context.type === 'multiview') next.push(...selectedImagesRef.current.filter((image) => image.view !== 'front'));
      const keepUrls = new Set(next.map((image) => image.previewUrl));
      for (const image of selectedImagesRef.current) {
        if (!keepUrls.has(image.previewUrl)) URL.revokeObjectURL(image.previewUrl);
      }
      selectedImagesRef.current = next;
      setSelectedImages(next);
      commit(idleState({ type, prompt: front ? fileStem(front.file.name) : '', images: next.map(imageMeta) }));
    },
    [clearSelectedImages, commit, textDraft],
  );

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
      const images = selectedImagesRef.current;
      const v =
        context.type === 'text'
          ? validateText(context.prompt, promptMaxRef.current)
          : validateImageSelection(context.type, images.map(imageMeta));
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
        const headers = apiHeaders();
        let body: BodyInit;
        if (context.type === 'text') {
          headers['content-type'] = 'application/json';
          body = JSON.stringify({ type: context.type, prompt: context.prompt.trim(), turnstileToken: token });
        } else {
          const form = new FormData();
          form.set('type', context.type);
          form.set('prompt', context.prompt);
          form.set('turnstileToken', token);
          for (const image of images) form.set(`image_${image.view}`, image.file, image.file.name);
          body = form;
        }
        const r = await fetch('/api/generate', {
          method: 'POST',
          headers,
          body,
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
    if (cur.phase !== 'success' || !cur.resultUrl || acceptingRef.current) return;
    acceptingRef.current = true;
    setAccepting(true);
    try {
      // T13a:结果经服务层代理(/api/task/:id/result),自带 key 通道靠 x-engine-key 头鉴权上游;
      // mock 的同源静态结果对多余头不敏感——同一行代码覆盖两个引擎。
      const r = await fetch(cur.resultUrl, { headers: apiHeaders() });
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      const file = new File([blob], resultFileName(cur.context.prompt), { type: 'model/gltf-binary' });
      startAiLanding(file, {
        prompt: cur.context.prompt,
        type: cur.context.type,
        taskId: cur.taskId ?? null,
        engine: engineNameRef.current,
      });
      acceptingRef.current = false;
      setAccepting(false);
      for (const image of selectedImagesRef.current) URL.revokeObjectURL(image.previewUrl);
      selectedImagesRef.current = [];
      setSelectedImages([]);
      setTextDraft('');
      commit(idleState());
    } catch {
      acceptingRef.current = false;
      setAccepting(false);
      commit({ ...cur, notice: '结果下载失败,请重试「接受」或稍后再试(链接仍有效)。' });
    }
  }, [commit]);

  const doAdjust = useCallback(() => {
    // AI-08:完整上下文回填,仅改差异。上下文从未离开输入区数据结构,回填即切回 idle。
    const cur = genRef.current;
    if (cur.context.type !== 'text' && selectedImagesRef.current.length === 0) {
      commit(idleState({ ...cur.context, images: [] }, '本地图片不会跨刷新保存，请重新添加图片后再生成。'));
      return;
    }
    commit(idleState(cur.context, '已回填原始输入,修改后重新提交(重新生成将计一次配额)。'));
    if (cur.context.type === 'text') setTimeout(() => taRef.current?.focus(), 0);
  }, [commit]);

  const doDiscard = useCallback(() => {
    for (const image of selectedImagesRef.current) URL.revokeObjectURL(image.previewUrl);
    selectedImagesRef.current = [];
    setSelectedImages([]);
    setTextDraft('');
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
      const notice = cur.context.type === 'text' ? '请修改描述后重新提交(原输入已保留)。' : '请更换输入图片后重新提交。';
      commit(idleState(cur.context, notice)); // 审核→修改输入/图片
      if (cur.context.type === 'text') setTimeout(() => taRef.current?.focus(), 0);
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
        const hj = (await h.json()) as { config?: { promptMax?: number; engineName?: string } };
        const m = hj?.config?.promptMax;
        engineNameRef.current = typeof hj?.config?.engineName === 'string' ? hj.config.engineName : null;
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

  useEffect(
    () => () => {
      for (const image of selectedImagesRef.current) URL.revokeObjectURL(image.previewUrl);
    },
    [],
  );

  // ---- 派生读数 ----
  const remaining = quota?.visitor.remaining ?? null;
  const breakerOpen = quota?.breaker.open ?? false;
  const blocked = !hasOwnKey && (breakerOpen || remaining === 0); // 提交前拦截(AI-07:不进入扣减)
  const p = gen.context.prompt;
  const overLimit = gen.context.type === 'text' && p.trim().length > promptMax;
  const imageValidation = validateImageSelection(gen.context.type, selectedImages.map(imageMeta));
  const imageReady = gen.context.type === 'text' || imageValidation.ok;

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
        return <span style={dim}>{gen.context.type === 'text' ? '提交中…' : '正在上传图片并创建任务…'}</span>;
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
            <button
              style={{ ...primaryBtn, ...(accepting ? { opacity: 0.6, cursor: 'wait' } : {}) }}
              disabled={accepting}
              onClick={() => void doAccept()}
            >
              {accepting ? '落入中…' : '接受'}
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
  const submitDisabled = inputLocked || blocked || overLimit || !imageReady;

  const removeImage = (view: ImageView) => {
    syncSelectedImages(selectedImagesRef.current.filter((image) => image.view !== view));
  };

  const renderImageSlot = (view: ImageView, label: string, hint: string, single = false) => {
    const selected = selectedImages.find((image) => image.view === view);
    return (
      <div className={`gen-image-slot${single ? ' gen-image-slot--single' : ''}${selected ? ' is-filled' : ''}`} key={view}>
        <label
          className="gen-image-slot__picker"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (!inputLocked) assignImages(view, Array.from(event.dataTransfer.files));
          }}
        >
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            multiple={gen.context.type === 'multiview' && view === 'front'}
            disabled={inputLocked}
            onChange={(event) => {
              assignImages(view, Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = '';
            }}
          />
          {selected ? (
            <>
              <img src={selected.previewUrl} alt={`${label}预览`} />
              <span className="gen-image-slot__scrim" />
              <span className="gen-image-slot__replace">点击替换</span>
            </>
          ) : (
            <span className="gen-image-slot__empty">
              <span className="gen-image-slot__plus">＋</span>
              <strong>{single ? '点击或拖入主体图片' : label}</strong>
              <small>{single ? 'PNG / JPG / WebP · 单张不超过 10MB' : hint}</small>
            </span>
          )}
        </label>
        {selected && (
          <>
            <span className="gen-image-slot__view">{label}</span>
            <button
              type="button"
              className="gen-image-slot__remove"
              aria-label={`删除${label}图片`}
              title={`删除${label}图片`}
              disabled={inputLocked}
              onClick={() => removeImage(view)}
            >
              ×
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="gen-panel" style={shell} data-testid="gen-panel" data-mode={gen.context.type}>
      <div style={inputRow}>
        <div className="gen-mode-tabs" role="tablist" aria-label="AI 生成方式">
          {([
            ['text', '文字'],
            ['image', '单图'],
            ['multiview', '多图'],
          ] as Array<[GenerateType, string]>).map(([type, label]) => (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={gen.context.type === type}
              className={gen.context.type === type ? 'is-active' : ''}
              disabled={inputLocked}
              onClick={() => switchMode(type)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="gen-input-surface">
          {gen.context.type === 'text' ? (
            <textarea
              ref={taRef}
              style={{ ...ta, ...(overLimit ? { borderColor: '#8f5a5a' } : {}) }}
              placeholder="例如：一个圆润的桌面耳机支架，底座稳固，适合 FDM 打印"
              value={p}
              disabled={inputLocked}
              onChange={(event) => {
                setTextDraft(event.target.value);
                commit(idleState({ type: 'text', prompt: event.target.value, images: [] }));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !inputLocked && !blocked) {
                  event.preventDefault();
                  void doSubmit(gen.context);
                }
              }}
            />
          ) : gen.context.type === 'image' ? (
            renderImageSlot('front', '主体图片', '必填', true)
          ) : (
            <div className="gen-multiview">
              <div className="gen-multiview__grid">
                {MULTIVIEW_SLOTS.map((slot) => renderImageSlot(slot.view, slot.label, slot.hint))}
              </div>
              <span className="gen-multiview__tip">至少 2 张同一物体 · 正面必填 · 角度尽量保持 90°</span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'center', alignItems: 'flex-end' }}>
          <button
            style={{ ...primaryBtn, ...(submitDisabled ? { opacity: 0.5, cursor: 'default' } : {}) }}
            disabled={submitDisabled}
            onClick={() => void doSubmit(gen.context)}
          >
            {gen.context.type === 'text' ? '生成' : '生成模型'}
          </button>
          <span style={{ ...dim, fontSize: 10, ...(overLimit ? { color: '#e0a8a8' } : {}) }}>
            {gen.context.type === 'text'
              ? `${p.trim().length}/${promptMax}`
              : gen.context.type === 'image'
                ? selectedImages.length > 0
                  ? '图片已就绪'
                  : '添加 1 张'
                : `${selectedImages.length}/3 张`}
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
