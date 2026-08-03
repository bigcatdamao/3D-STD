import { doc } from '../state/store';
import {
  applyConnector,
  backConnectorStep,
  cancelConnector,
  connectorIsStale,
  generateConnectorPreview,
  setConnectorFirstRole,
  setConnectorParameter,
  useConnector,
} from './connector-state';
import type { ConnectorCandidate, ConnectorRole } from './connector-geometry';

function nameOf(id: string | null): string {
  return id ? doc.nodes.get(id)?.name ?? '零件' : '未选择';
}

function CandidateCard({ candidate, empty }: { candidate: ConnectorCandidate | null; empty: string }) {
  if (!candidate) return <div className="connector-candidate is-empty">{empty}</div>;
  return (
    <div className={`connector-candidate is-${candidate.rating}`}>
      <strong>{candidate.rating === 'good' ? '可用连接面' : candidate.rating === 'warning' ? '空间偏紧' : '不建议使用'}</strong>
      <span>{candidate.message}</span>
      <small>建议直径 ≤ {candidate.recommendedMaxDiameterMm.toFixed(1)} mm · 深度参考 {candidate.estimatedDepthMm.toFixed(1)} mm</small>
    </div>
  );
}

function RoleChoice({ value, onChange }: { value: ConnectorRole; onChange: (value: ConnectorRole) => void }) {
  return (
    <div className="connector-role" role="radiogroup" aria-label="第一个零件的连接角色">
      <button className={value === 'male' ? 'is-active' : ''} onClick={() => onChange('male')}>
        <b>凸榫</b><span>第一个零件伸出插销</span>
      </button>
      <button className={value === 'female' ? 'is-active' : ''} onClick={() => onChange('female')}>
        <b>凹槽</b><span>第一个零件生成圆孔</span>
      </button>
    </div>
  );
}

function Parameter({
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
  note,
}: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  note: string;
}) {
  return (
    <label className="connector-parameter">
      <span><b>{label}</b><output>{value.toFixed(step < 0.1 ? 2 : 1)} {unit}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <small>{note}</small>
    </label>
  );
}

export function ConnectorPanel() {
  const state = useConnector();
  const stale = connectorIsStale();
  const firstName = nameOf(state.firstInstanceId);
  const secondName = nameOf(state.secondInstanceId);
  const step = state.phase === 'pickFirst' ? 1 : state.phase === 'pickSecond' ? 2 : 3;
  const canBack = state.phase !== 'pickFirst' && state.phase !== 'previewing' && state.phase !== 'applying';

  return (
    <div className="connector-panel" data-testid="connector-panel">
      <div className="connector-panel__version">M1.18 · 简单连接器</div>
      <h2>连接两个零件</h2>
      <p className="connector-panel__subtitle">圆柱插销 + 配对圆孔 · 真实布尔 · 一步撤销</p>

      <div className="connector-steps" aria-label="连接步骤">
        {[1, 2, 3].map((item) => (
          <span key={item} className={item === step ? 'is-active' : item < step ? 'is-done' : ''}>
            <b>{item}</b>{item === 1 ? '定第一点' : item === 2 ? '配对第二件' : '预览确认'}
          </span>
        ))}
      </div>

      {stale && <div className="connector-alert is-error">场景已经变化，请退出连接工具后重新开始。</div>}

      {state.phase === 'pickFirst' && (
        <>
          <section className="connector-section">
            <div className="connector-object-row"><span>A</span><b>{firstName}</b><em>已选中</em></div>
            <h3>在第一个零件上点击连接中心</h3>
            <p>把光标移到希望安装插销的位置。绿色表示可用，黄色表示空间偏紧。</p>
          </section>
          <CandidateCard candidate={state.hover} empty="在模型表面移动光标，系统会实时检查此处空间与朝向" />
        </>
      )}

      {state.phase === 'pickSecond' && (
        <>
          <section className="connector-section">
            <div className="connector-object-row"><span>A</span><b>{firstName}</b><em>位置已定</em></div>
            <h3>第一件做凸榫还是凹槽？</h3>
            <RoleChoice value={state.firstRole} onChange={setConnectorFirstRole} />
          </section>
          <section className="connector-section">
            <h3>再点击另一个零件的配对位置</h3>
            <p>画布中的连线表示连接方向。第二件会自动采用相反角色。</p>
          </section>
          <CandidateCard candidate={state.hover} empty="将光标移到另一个零件；不能选择第一个零件本身" />
        </>
      )}

      {(state.phase === 'configure' || state.phase === 'error') && (
        <>
          <div className="connector-pair-summary">
            <div><span>A · {state.firstRole === 'male' ? '凸榫' : '凹槽'}</span><b>{firstName}</b></div>
            <i aria-hidden="true">→</i>
            <div><span>B · {state.firstRole === 'male' ? '凹槽' : '凸榫'}</span><b>{secondName}</b></div>
          </div>
          <RoleChoice value={state.firstRole} onChange={setConnectorFirstRole} />
          <section className="connector-section connector-section--parameters">
            <h3>连接尺寸</h3>
            <Parameter
              label="插销直径"
              value={state.parameters.diameterMm}
              unit="mm"
              min={1.5}
              max={16}
              step={0.5}
              onChange={(value) => setConnectorParameter('diameterMm', value)}
              note="首版使用圆柱插销；直径越大，抗剪强度越高。"
            />
            <Parameter
              label="插入深度"
              value={state.parameters.depthMm}
              unit="mm"
              min={2}
              max={24}
              step={0.5}
              onChange={(value) => setConnectorParameter('depthMm', value)}
              note="两侧沿连接方向生成相同有效深度。"
            />
            <Parameter
              label="装配间隙"
              value={state.parameters.clearanceMm}
              unit="mm"
              min={0.05}
              max={1.2}
              step={0.05}
              onChange={(value) => setConnectorParameter('clearanceMm', value)}
              note="圆孔直径与插销直径之差；树脂可从 0.15–0.25 mm 试起，FDM 可从 0.25–0.45 mm 试起。"
            />
          </section>
          {state.error && <div className="connector-alert is-error"><b>暂时无法生成</b><span>{state.error}</span></div>}
        </>
      )}

      {state.phase === 'previewing' && (
        <div className="connector-progress"><span className="connector-spinner" /><b>正在计算真实布尔…</b><small>凸侧并集、凹侧差集；原模型尚未修改。</small></div>
      )}

      {state.phase === 'previewReady' && (
        <>
          <div className="connector-alert is-success">
            <b>连接预览已生成</b>
            <span>绿色为第一件，紫色为第二件。请旋转视图检查插销与圆孔位置。</span>
          </div>
          <div className="connector-preview-facts">
            <span><b>Ø {state.parameters.diameterMm.toFixed(1)}</b>插销</span>
            <span><b>Ø {(state.parameters.diameterMm + state.parameters.clearanceMm).toFixed(2)}</b>圆孔</span>
            <span><b>{state.parameters.depthMm.toFixed(1)} mm</b>深度</span>
          </div>
          <div className="connector-alert"><b>此时没有修改模型</b><span>确认后才创建两个派生资产并写入一条历史记录。</span></div>
        </>
      )}

      <div className="connector-actions">
        <button className="connector-secondary" onClick={canBack ? backConnectorStep : cancelConnector} disabled={state.phase === 'previewing' || state.phase === 'applying'}>
          {canBack ? '返回上一步' : '退出连接'}
        </button>
        {(state.phase === 'configure' || state.phase === 'error') && (
          <button className="connector-primary" onClick={() => void generateConnectorPreview()}>生成连接预览</button>
        )}
        {state.phase === 'previewReady' && (
          <button className="connector-primary" onClick={applyConnector}>确认并生成连接</button>
        )}
      </div>
      <div className="connector-panel__footnote">Esc 退出 · 预览前不改模型 · 确认后 Ctrl+Z 可整体撤销</div>
    </div>
  );
}
