import { useEffect, useMemo, useState } from 'react';
import { requestCreationAgent } from './creation-agent-api';
import type {
  CreationAgentApiOutput,
  CreationAgentBrief,
  CreationAgentHistoryItem,
  CreationProjectType,
  CreationPurpose,
} from './creation-agent-api-types';
import {
  applyQuestionAnswers,
  buildLocalCreationTurn,
  CREATION_AGENT_SESSION_KEY,
  emptyCreationBrief,
  projectTypeLabel,
  purposeLabel,
} from './creation-agent-logic';

interface ChatMessage extends CreationAgentHistoryItem {
  id: string;
  source?: 'ai' | 'local' | 'system';
}

interface SavedSession {
  brief: CreationAgentBrief;
  messages: ChatMessage[];
  output: CreationAgentApiOutput | null;
  confirmed: boolean;
}

const welcome: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  source: 'system',
  content: '先告诉我你想做什么。不需要写完整提示词，我会把模糊想法整理成一份可确认的 3D 创作需求。',
};

const starterIdeas = [
  '我想做一个原创角色手办',
  '设计一台适合打印的科幻机甲',
  '把一个产品想法做成 3D 原型',
];

function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function initialSession(): SavedSession {
  return { brief: emptyCreationBrief(), messages: [welcome], output: null, confirmed: false };
}

export function CreationAgentPanel() {
  const [session, setSession] = useState<SavedSession>(initialSession);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [serviceLabel, setServiceLabel] = useState('等待首次对话');

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CREATION_AGENT_SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<SavedSession>;
      if (saved.brief && Array.isArray(saved.messages)) {
        setSession({
          brief: saved.brief,
          messages: saved.messages.slice(-24),
          output: saved.output ?? null,
          confirmed: saved.confirmed === true,
        });
      }
    } catch {
      /* 损坏的草稿直接忽略，不阻断创作入口。 */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CREATION_AGENT_SESSION_KEY, JSON.stringify(session));
    } catch {
      /* 无 storage 时只失去刷新恢复。 */
    }
  }, [session]);

  const readiness = Math.round((session.output?.readiness.score ?? 0) * 100);
  const canConfirm = Boolean(
    session.brief.subject
    && session.brief.projectType !== 'unknown'
    && session.brief.purpose !== 'unknown'
    && session.brief.style,
  );

  const history = useMemo<CreationAgentHistoryItem[]>(
    () => session.messages.filter((item) => item.id !== 'welcome').slice(-12).map(({ role, content }) => ({ role, content })),
    [session.messages],
  );

  const sendMessage = async (rawMessage: string, briefOverride?: CreationAgentBrief) => {
    const message = rawMessage.trim();
    if (!message || busy) return;
    const currentBrief = briefOverride ?? session.brief;
    const userMessage: ChatMessage = { id: nextId('user'), role: 'user', content: message };
    setSession((current) => ({ ...current, brief: currentBrief, confirmed: false, messages: [...current.messages, userMessage] }));
    setDraft('');
    setBusy(true);
    setFallbackNotice(null);
    try {
      const response = await requestCreationAgent({
        schemaVersion: 'creation-agent-input.v1',
        requestId: `creation_${Date.now()}`,
        locale: 'zh-CN',
        message,
        brief: currentBrief,
        history,
        referenceImageCount: 0,
      });
      const assistant: ChatMessage = { id: nextId('assistant'), role: 'assistant', source: 'ai', content: response.result.message };
      setSession((current) => ({
        ...current,
        brief: response.result.brief,
        output: response.result,
        confirmed: false,
        messages: [...current.messages, assistant],
      }));
      setServiceLabel(`${response.meta.provider} · ${response.meta.model}`);
      setAnswers({});
    } catch (error) {
      const local = buildLocalCreationTurn(currentBrief, message);
      const assistant: ChatMessage = { id: nextId('assistant'), role: 'assistant', source: 'local', content: local.message };
      setSession((current) => ({
        ...current,
        brief: local.brief,
        output: local,
        confirmed: false,
        messages: [...current.messages, assistant],
      }));
      setServiceLabel('本地引导');
      setFallbackNotice(`${error instanceof Error ? error.message : 'AI 服务暂时不可用'} 本轮使用本地规则整理，没有调用付费生成。`);
      setAnswers({});
    } finally {
      setBusy(false);
    }
  };

  const submitAnswers = () => {
    if (!session.output?.questions.length || session.output.questions.some((question) => !answers[question.questionId])) return;
    const applied = applyQuestionAnswers(session.brief, answers);
    void sendMessage(`我的选择是：${applied.summary}`, applied.brief);
  };

  const updateBrief = (patch: Partial<CreationAgentBrief>) => {
    setSession((current) => ({ ...current, brief: { ...current.brief, ...patch }, confirmed: false }));
  };

  const confirmBrief = () => {
    if (!canConfirm) return;
    const assistant: ChatMessage = {
      id: nextId('confirmed'),
      role: 'assistant',
      source: 'system',
      content: '创作需求已确认。M1.14a 会在这里停下；下一阶段再由你明确授权是否生成效果图或多视图，不会自动产生付费调用。',
    };
    setSession((current) => ({ ...current, confirmed: true, messages: [...current.messages, assistant] }));
  };

  const reset = () => {
    setSession(initialSession());
    setDraft('');
    setAnswers({});
    setFallbackNotice(null);
    setServiceLabel('等待首次对话');
  };

  return (
    <div className="creation-agent" data-testid="creation-agent-panel">
      <section className="creation-agent__conversation" aria-label="3D 创作 Agent 对话">
        <div className="creation-agent__status">
          <span className="creation-agent__live"><i /> 需求理解</span>
          <span>{serviceLabel}</span>
          <button type="button" onClick={reset}>重新开始</button>
        </div>
        <div className="creation-agent__messages" aria-live="polite">
          {session.messages.map((message) => (
            <article key={message.id} className={`creation-agent__message is-${message.role}`}>
              <div className="creation-agent__avatar">{message.role === 'assistant' ? '✦' : '你'}</div>
              <div>
                <p>{message.content}</p>
                {message.source === 'local' && <small>本地引导 · 未调用大模型</small>}
                {message.source === 'ai' && <small>Agent 结构化整理</small>}
              </div>
            </article>
          ))}
          {busy && <div className="creation-agent__thinking"><span /><span /><span /> 正在理解需求…</div>}
        </div>

        {session.messages.length === 1 && (
          <div className="creation-agent__starters">
            {starterIdeas.map((idea) => <button key={idea} type="button" onClick={() => void sendMessage(idea)}>{idea}</button>)}
          </div>
        )}

        {fallbackNotice && <div className="creation-agent__fallback">{fallbackNotice}</div>}

        {!!session.output?.questions.length && (
          <div className="creation-agent__questions">
            <div className="creation-agent__section-title">还需确认 {session.output.questions.length} 项</div>
            {session.output.questions.map((question, index) => (
              <fieldset key={question.questionId}>
                <legend>{index + 1}. {question.question}</legend>
                <div className="creation-agent__options">
                  {question.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={answers[question.questionId] === option.value ? 'is-selected' : ''}
                      onClick={() => setAnswers((current) => ({ ...current, [question.questionId]: option.value }))}
                    >
                      <strong>{option.label}{option.recommended ? <em>推荐</em> : null}</strong>
                      <small>{option.description}</small>
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
            <button
              className="creation-agent__answer-submit"
              type="button"
              disabled={session.output.questions.some((question) => !answers[question.questionId]) || busy}
              onClick={submitAnswers}
            >
              提交选择
            </button>
          </div>
        )}

        <div className="creation-agent__composer">
          <textarea
            value={draft}
            maxLength={2000}
            placeholder="例如：我想做一个圆润可爱的蘑菇冒险家，用树脂打印…"
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendMessage(draft);
              }
            }}
          />
          <button type="button" disabled={!draft.trim() || busy} onClick={() => void sendMessage(draft)}>{busy ? '整理中' : '发送'}</button>
        </div>
        <small className="creation-agent__boundary">本阶段只整理需求 · 不自动生图 · 不自动生成 3D · 不修改场景</small>
      </section>

      <aside className="creation-agent__brief" aria-label="创作需求 Brief">
        <div className="creation-agent__brief-head">
          <div><span>创作 Brief</span><strong>{session.confirmed ? '已确认' : canConfirm ? '待确认' : '整理中'}</strong></div>
          <b>{readiness}%</b>
        </div>
        <label>创作对象<input value={session.brief.subject ?? ''} placeholder="例如：蘑菇冒险家" onChange={(event) => updateBrief({ subject: event.target.value || null })} /></label>
        <div className="creation-agent__brief-grid">
          <label>模型类型
            <select value={session.brief.projectType} onChange={(event) => updateBrief({ projectType: event.target.value as CreationProjectType })}>
              {(['unknown', 'character', 'mecha', 'prop', 'product', 'scene', 'other'] as CreationProjectType[]).map((value) => <option key={value} value={value}>{projectTypeLabel(value)}</option>)}
            </select>
          </label>
          <label>最终用途
            <select value={session.brief.purpose} onChange={(event) => updateBrief({ purpose: event.target.value as CreationPurpose })}>
              {(['unknown', 'resin_print', 'fdm_print', 'display', 'prototype'] as CreationPurpose[]).map((value) => <option key={value} value={value}>{purposeLabel(value)}</option>)}
            </select>
          </label>
        </div>
        <label>视觉风格<input value={session.brief.style ?? ''} placeholder="例如：可爱卡通、科幻机甲" onChange={(event) => updateBrief({ style: event.target.value || null })} /></label>
        <div className="creation-agent__brief-grid">
          <label>目标高度 mm<input type="number" min="1" max="5000" value={session.brief.targetHeightMm ?? ''} placeholder="可稍后决定" onChange={(event) => updateBrief({ targetHeightMm: event.target.value ? Number(event.target.value) : null })} /></label>
          <label>姿态<input value={session.brief.pose ?? ''} placeholder="站立、动态姿势…" onChange={(event) => updateBrief({ pose: event.target.value || null })} /></label>
        </div>
        {!!session.output?.readiness.missingFields.length && (
          <div className="creation-agent__missing">仍需确认：{session.output.readiness.missingFields.join('、')}</div>
        )}
        <div className="creation-agent__next">
          <strong>{session.confirmed ? '需求已锁定' : '下一步：确认创作需求'}</strong>
          <p>{session.confirmed ? '后续将单独预览效果图方案，并再次征得你的确认。' : '确认只保存 Brief，不会立即调用任何生成服务。'}</p>
        </div>
        <button className="creation-agent__confirm" type="button" disabled={!canConfirm || session.confirmed} onClick={confirmBrief}>
          {session.confirmed ? '✓ 已确认创作需求' : '确认创作需求'}
        </button>
      </aside>
    </div>
  );
}
