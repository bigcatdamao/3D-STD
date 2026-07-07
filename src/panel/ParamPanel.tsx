// 参数面板(T8)—— PANEL-01~07 全部 P0 + 边界 1/2/3。
//
// 上下文三态(PANEL-01):无选中 = 场景/打印床设置;单实例 = 全属性;
// 多实例(含选中组的展开,见 panel-logic 裁决 1)= 共同属性 + 混合值语义。
// 分组渐进披露(PANEL-02):变换默认展开;材质、对象信息默认折叠。
// C6:面板 = 绝对值语义。混合值示「多值」占位,输入即绝对统一;混合态无增量起点,
// 方向键步进与 scrub 同理禁用(PANEL 边界 4;scrub 本身 P1 未做)。
// 性能:gizmo 拖拽期间 rev 随 pointermove 高频跳动,本面板经 useThrottledRev 节流刷新
// (VIEW §6.5「gizmo 拖拽期间面板数值节流刷新」)。

import { useEffect, useMemo, useRef, useState } from 'react';
import { InstanceNode } from '../kernel/types';
import { BED_PRESETS, dispatch, doc, useUi } from '../state/store';
import { colorFor, DEFAULT_METALNESS, DEFAULT_ROUGHNESS } from '../viewport/SceneInstances';
import {
  assetExtent,
  commonString,
  commonValue,
  fmt2,
  localSizeMm,
  panelTargets,
  parseNumeric,
  scaleFromSizeMm,
  stepDelta,
  targetsBBox,
  targetsSig,
} from './panel-logic';

const AMBER = '#ffb454';
const PANEL_BG = '#1b1b20';
const BORDER = '#2b2b31';
const MUTED = '#8b8b93';
const TEXT = '#c9c9d1';
const AXIS_TINT = ['#e07777', '#5dbb7a', '#6aa9e8']; // X / Y / Z

// ---------- 节流的文档版本订阅(性能注) ----------
function useThrottledRev(ms = 80): number {
  const [rev, setRev] = useState(() => useUi.getState().rev);
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useUi.subscribe((s) => {
      const now = Date.now();
      if (now - last >= ms) {
        last = now;
        setRev(s.rev);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          setRev(useUi.getState().rev);
        }, ms - (now - last));
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [ms]);
  return rev;
}

// ---------- 渐进披露分组(PANEL-02) ----------
function Section({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: `1px solid ${BORDER}` }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: '7px 10px',
          fontSize: 12,
          fontWeight: 600,
          color: open ? '#e8e8ea' : MUTED,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{ display: 'inline-block', width: 14, color: MUTED }}>{open ? '▾' : '▸'}</span>
        {title}
      </div>
      {open && <div style={{ padding: '0 10px 10px' }}>{children}</div>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
      <span style={{ width: 52, flex: 'none', fontSize: 11, color: MUTED }}>{label}</span>
      <div style={{ display: 'flex', gap: 4, flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

// ---------- 数值输入(PANEL-05/06 + 边界 2) ----------
interface NumProps {
  value: number | null; // null = 混合 →「多值」占位
  sig: string; // 目标签名:编辑期间选中集变化 → 提交丢弃(边界 2)
  onCommit: (v: number) => void;
  disabled?: boolean;
  axis?: 0 | 1 | 2; // 轴色提示
  title?: string;
}

function NumberField({ value, sig, onCommit, disabled, axis, title }: NumProps) {
  const [draft, setDraft] = useState<string | null>(null); // 非空 = 编辑中,外部 rev 不覆盖
  const sigAt = useRef(sig);
  const cancelled = useRef(false);

  const tryCommit = (raw: string) => {
    if (sigAt.current !== sig) return; // 边界 2:原目标集已变 → 丢弃本次编辑,不报错
    const v = parseNumeric(raw);
    if (v == null) return; // 非法输入:失焦还原(PANEL-05)
    if (value != null && v === value) return; // 无变化不提交(舍入不回写由全精度草稿保证)
    onCommit(v);
  };

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      {axis != null && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 4,
            bottom: 4,
            width: 2,
            borderRadius: 1,
            background: AXIS_TINT[axis],
            opacity: disabled ? 0.35 : 0.9,
          }}
        />
      )}
      <input
        title={title}
        disabled={disabled}
        value={draft ?? (value == null ? '' : fmt2(value))} // 显示 2 位小数;聚焦转全精度草稿
        placeholder={value == null ? '多值' : undefined} // PANEL-03 混合占位
        onFocus={(e) => {
          sigAt.current = sig;
          cancelled.current = false;
          setDraft(value == null ? '' : String(value)); // 全精度进入编辑(存储全精度,PANEL-05)
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select()); // 等草稿落入 value 后再全选
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!cancelled.current && draft != null) tryCommit(draft);
          cancelled.current = false;
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur(); // blur 统一走提交
          } else if (e.key === 'Escape') {
            cancelled.current = true; // 还原、不提交
            setDraft(null);
            e.currentTarget.blur();
            e.stopPropagation();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const base = draft != null ? (parseNumeric(draft) ?? value) : value;
            if (base == null) return; // 混合态无增量起点(与边界 4 禁 scrub 同理)
            const next = Math.round((base + stepDelta(e, e.key === 'ArrowUp' ? 1 : -1)) * 1e6) / 1e6;
            sigAt.current = sig;
            setDraft(String(next));
            if (!(value != null && next === value)) onCommit(next); // 每次步进提交,内核 800ms 合并(C1)
          }
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          background: '#141417',
          border: `1px solid ${BORDER}`,
          borderRadius: 5,
          color: disabled ? MUTED : TEXT,
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          padding: `4px 6px 4px ${axis != null ? 8 : 6}px`,
          outline: 'none',
          opacity: disabled ? 0.6 : 1,
        }}
      />
    </div>
  );
}

// ---------- 无选中态:场景 / 打印床设置(PANEL-01) ----------
function SceneSettings() {
  const bed = useUi((s) => s.bed);
  const setBed = useUi((s) => s.setBed);
  const presetIdx = BED_PRESETS.findIndex(
    (p) => p.bed.x === bed.x && p.bed.y === bed.y && p.bed.z === bed.z,
  );
  const setDim = (k: 'x' | 'y' | 'z') => (v: number) =>
    setBed({ ...bed, [k]: Math.max(1, Math.round(v)) });

  return (
    <>
      <Section title="打印床" defaultOpen>
        {/* 床设置属视图/环境配置,不入历史栈(C1 第三类);T17 起随项目持久化 */}
        <Row label="预设">
          <select
            value={presetIdx < 0 ? 'custom' : String(presetIdx)}
            onChange={(e) => {
              if (e.target.value !== 'custom') setBed(BED_PRESETS[Number(e.target.value)].bed);
            }}
            style={{
              flex: 1,
              background: '#141417',
              border: `1px solid ${BORDER}`,
              borderRadius: 5,
              color: TEXT,
              fontSize: 12,
              padding: '4px 6px',
            }}
          >
            {BED_PRESETS.map((p, i) => (
              <option key={p.label} value={String(i)}>
                {p.label}
              </option>
            ))}
            <option value="custom">自定义</option>
          </select>
        </Row>
        <Row label="尺寸 mm">
          <NumberField value={bed.x} sig="bed" axis={0} onCommit={setDim('x')} />
          <NumberField value={bed.y} sig="bed" axis={1} onCommit={setDim('y')} />
          <NumberField value={bed.z} sig="bed" axis={2} onCommit={setDim('z')} />
        </Row>
      </Section>
      <div style={{ padding: 14, fontSize: 12, color: MUTED, lineHeight: 1.7, textAlign: 'center' }}>
        选中对象后在此编辑
        <br />
        变换与材质属性
      </div>
    </>
  );
}

// ---------- 变换组(PANEL-03/04/05/06) ----------
function TransformSection({
  show,
  edit,
  readOnly,
}: {
  show: InstanceNode[]; // 显示来源集(可编辑集;全锁定时退化为全集只读)
  edit: InstanceNode[]; // 提交目标集
  readOnly: boolean;
}) {
  const [uniformLock, setUniformLock] = useState(true); // PANEL-04 统一缩放锁默认开启(UI 态,不入栈)
  const sig = targetsSig(edit);
  const ids = edit.map((n) => n.id);
  const single = show.length === 1;

  const bbox = targetsBBox(doc, show);
  const posValue = (axis: 0 | 1 | 2): number | null =>
    single ? show[0].transform.position[axis] : (bbox ? bbox.center[axis] : null);

  const rotCommon = (axis: 0 | 1 | 2) => commonValue(show.map((n) => n.transform.rotation[axis]));
  const scalePct = (axis: 0 | 1 | 2) => {
    const c = commonValue(show.map((n) => n.transform.scale[axis]));
    return c == null ? null : c * 100;
  };

  const extent = single ? assetExtent(doc, show[0]) : null;
  const sizeMm = single && extent ? localSizeMm(extent, show[0].transform.scale) : null;

  // 提交基准一律从内核实时重取 —— 面板刷新经节流(见 useThrottledRev),渲染时的中心/共同值
  // 在快速连续步进下可能滞后一拍;用滞后基准算增量会产生漂移(值与视口不一致)。
  const liveTargets = (): InstanceNode[] =>
    ids
      .map((id) => doc.nodes.get(id))
      .filter((n): n is InstanceNode => !!n && n.kind === 'instance');

  const commitPos = (axis: 0 | 1 | 2) => (v: number) => {
    if (single) {
      dispatch((d) => d.setTransformFieldMulti(ids, 'position', axis, v));
    } else {
      // PANEL-03 多选位置 = 整体平移保持相对位置(delta = 目标值 − 实时中心)
      const box = targetsBBox(doc, liveTargets());
      if (!box) return;
      dispatch((d) => d.translateInstancesAxis(ids, axis, v - box.center[axis]));
    }
  };

  const commitRot = (axis: 0 | 1 | 2) => (v: number) =>
    dispatch((d) => d.setTransformFieldMulti(ids, 'rotation', axis, v)); // 绝对统一(C6/PANEL-03)

  const commitScalePct = (axis: 0 | 1 | 2) => (pct: number) => {
    if (uniformLock) {
      const c = commonValue(liveTargets().map((n) => n.transform.scale[axis]));
      if (c != null && c !== 0) {
        dispatch((d) => d.scaleInstancesFactor(ids, pct / 100 / c)); // 等比:保持轴间/成员间比例(裁决 3)
      } else {
        dispatch((d) => d.setUniformScale(ids, pct / 100)); // 边界 3:锁 + 混合 → 绝对目标统一
      }
    } else {
      dispatch((d) => d.setTransformFieldMulti(ids, 'scale', axis, pct / 100));
    }
  };

  const commitSizeMm = (axis: 0 | 1 | 2) => (mm: number) => {
    if (!single || !extent) return;
    const ns = scaleFromSizeMm(extent[axis], mm);
    if (ns == null) return; // 退化轴只读
    const cur = doc.instance(ids[0]).transform.scale[axis]; // 实时基准,同上
    if (uniformLock && cur !== 0) dispatch((d) => d.scaleInstancesFactor(ids, ns / cur));
    else dispatch((d) => d.setTransformFieldMulti(ids, 'scale', axis, ns));
  };

  return (
    <Section title="变换" defaultOpen>
      <Row label="位置 mm">
        {([0, 1, 2] as const).map((a) => (
          <NumberField
            key={a}
            axis={a}
            value={posValue(a)}
            sig={sig}
            disabled={readOnly}
            onCommit={commitPos(a)}
            title={single ? undefined : '多选:显示包围盒中心;编辑 = 整体平移保持相对位置'}
          />
        ))}
      </Row>
      <Row label="旋转 °">
        {([0, 1, 2] as const).map((a) => (
          <NumberField
            key={a}
            axis={a}
            value={rotCommon(a)}
            sig={sig}
            disabled={readOnly}
            onCommit={commitRot(a)}
            title="归一到 (-180, 180],欧拉序固定 XYZ"
          />
        ))}
      </Row>
      <Row label="缩放 %">
        {([0, 1, 2] as const).map((a) => (
          <NumberField
            key={a}
            axis={a}
            value={scalePct(a)}
            sig={sig}
            disabled={readOnly}
            onCommit={commitScalePct(a)}
            title="下限 0.1%,禁负(镜像为显式操作)"
          />
        ))}
        <button
          onClick={() => setUniformLock(!uniformLock)}
          disabled={readOnly}
          title="统一缩放锁:开启时按等比联动三轴;混合值时输入作为绝对目标统一应用"
          style={{
            flex: 'none',
            width: 26,
            background: uniformLock ? '#2e2a22' : '#26262e',
            border: `1px solid ${uniformLock ? AMBER : '#34343e'}`,
            borderRadius: 5,
            color: uniformLock ? AMBER : MUTED,
            fontSize: 12,
            cursor: readOnly ? 'default' : 'pointer',
            padding: 0,
          }}
        >
          {uniformLock ? '🔗' : '⛓'}
        </button>
      </Row>
      {single && sizeMm ? (
        <Row label="尺寸 mm">
          {([0, 1, 2] as const).map((a) => (
            <NumberField
              key={a}
              axis={a}
              value={extent && extent[a] > 1e-6 ? sizeMm[a] : null}
              sig={sig}
              disabled={readOnly || !extent || extent[a] <= 1e-6}
              onCommit={commitSizeMm(a)}
              title="本体尺寸(资产跨度 × 缩放),与旋转无关;世界包围盒见「对象信息」"
            />
          ))}
        </Row>
      ) : (
        bbox && (
          <Row label="尺寸 mm">
            <span
              title="多选时尺寸只读(PANEL-04):选中集世界包围盒"
              style={{ fontSize: 12, color: MUTED, fontVariantNumeric: 'tabular-nums', padding: '4px 0' }}
            >
              {fmt2(bbox.size[0])} × {fmt2(bbox.size[1])} × {fmt2(bbox.size[2])}(只读)
            </span>
          </Row>
        )
      )}
    </Section>
  );
}

// ---------- 材质组(PANEL-07,C2 实例级覆盖) ----------
/** 滑杆 = 连续型操作:一次拖动为一步(C1 第二类),经交互会话实现;数值框走 800ms 合并通道 */
function useMatSession(ids: string[], label: string) {
  const active = useRef(false);
  const update = (mut: (inst: InstanceNode) => void) => {
    if (!ids.length) return;
    if (!active.current) {
      dispatch((d) => d.beginInteraction(label, ids));
      active.current = true;
    }
    dispatch((d) =>
      d.updateInteraction(() => {
        for (const id of ids) mut(doc.instance(id));
      }),
    );
  };
  const commit = () => {
    if (!active.current) return;
    active.current = false;
    dispatch((d) => d.commitInteraction());
  };
  // 组件卸载时兜底提交,不留半开会话
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return { update, commit };
}

function MatSlider({
  label,
  matKey,
  ids,
  common,
  sig,
  readOnly,
}: {
  label: string;
  matKey: 'roughness' | 'metalness';
  ids: string[];
  common: number | null;
  sig: string;
  readOnly: boolean;
}) {
  const session = useMatSession(ids, `${label}${ids.length > 1 ? `(${ids.length} 个对象)` : ''}`);
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return (
    <Row label={label}>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        disabled={readOnly}
        value={common ?? 0.5}
        onChange={(e) => {
          // 拖动/键盘期间连续触发:并入同一交互会话,松手(change 后无后续 input)由 pointerup/blur 收口
          const v = clamp01(Number(e.target.value));
          session.update((inst) => {
            inst.materialOverride = { ...(inst.materialOverride ?? {}), [matKey]: v };
          });
        }}
        onPointerUp={session.commit}
        onBlur={session.commit}
        onKeyUp={session.commit}
        style={{ flex: 1, accentColor: AMBER, minWidth: 0 }}
      />
      <div style={{ width: 64, flex: 'none' }}>
        <NumberField
          value={common}
          sig={sig}
          disabled={readOnly}
          onCommit={(v) => dispatch((d) => d.setMaterialParam(ids, matKey, clamp01(v)))}
          title="0 – 1"
        />
      </div>
    </Row>
  );
}

function MaterialSection({
  show,
  edit,
  readOnly,
}: {
  show: InstanceNode[];
  edit: InstanceNode[];
  readOnly: boolean;
}) {
  const ids = edit.map((n) => n.id);
  const sig = targetsSig(edit);
  const ov = (n: InstanceNode) =>
    (n.materialOverride ?? {}) as { color?: string; roughness?: number; metalness?: number };

  // 显示基准与渲染同源:无覆盖 = 资产体色 / 默认 PBR 参数
  const colorCommon = commonString(show.map((n) => ov(n).color ?? colorFor(n.assetId)));
  const roughCommon = commonValue(show.map((n) => ov(n).roughness ?? DEFAULT_ROUGHNESS));
  const metalCommon = commonValue(show.map((n) => ov(n).metalness ?? DEFAULT_METALNESS));
  const colorSession = useMatSession(ids, `颜色${ids.length > 1 ? `(${ids.length} 个对象)` : ''}`);

  return (
    <Section title="材质" defaultOpen={false}>
      <Row label="颜色">
        <input
          type="color"
          disabled={readOnly}
          value={colorCommon ?? '#888888'}
          onChange={(e) => {
            // 取色器拖动期间连续触发 → 同一交互会话;关闭/失焦收口为一步(C1)
            const hex = e.target.value;
            colorSession.update((inst) => {
              inst.materialOverride = { ...(inst.materialOverride ?? {}), color: hex };
            });
          }}
          onBlur={colorSession.commit}
          style={{
            width: 34,
            height: 26,
            flex: 'none',
            padding: 0,
            border: `1px solid ${BORDER}`,
            borderRadius: 5,
            background: '#141417',
            cursor: readOnly ? 'default' : 'pointer',
          }}
        />
        <span style={{ fontSize: 12, color: colorCommon ? TEXT : MUTED, alignSelf: 'center' }}>
          {colorCommon ?? '多值'}
        </span>
      </Row>
      <MatSlider label="粗糙度" matKey="roughness" ids={ids} common={roughCommon} sig={sig} readOnly={readOnly} />
      <MatSlider label="金属度" matKey="metalness" ids={ids} common={metalCommon} sig={sig} readOnly={readOnly} />
      <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.6 }}>
        实例级覆盖(C2):删除实例不影响资产;AMS 打印颜色映射为 P2,与渲染材质分离。
      </div>
    </Section>
  );
}

// ---------- 对象信息组(PANEL-02 默认折叠) ----------
function InfoSection({ all }: { all: InstanceNode[] }) {
  const line = (k: string, v: string) => (
    <div key={k} style={{ display: 'flex', fontSize: 12, marginBottom: 4 }}>
      <span style={{ width: 72, flex: 'none', color: MUTED }}>{k}</span>
      <span style={{ color: TEXT, wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
  let body: React.ReactNode;
  if (all.length === 1) {
    const n = all[0];
    const a = doc.assets.get(n.assetId);
    const world = targetsBBox(doc, all);
    body = (
      <>
        {line('名称', n.name)}
        {a && line('资产', a.name)}
        {a && line('来源', a.source === 'ai' ? 'AI 生成' : '导入')}
        {a && line('面数', a.meta.faces.toLocaleString())}
        {world && line('世界包围盒', `${fmt2(world.size[0])} × ${fmt2(world.size[1])} × ${fmt2(world.size[2])} mm`)}
        {line('状态', `${n.visible ? '显示' : '隐藏'} · ${doc.effectiveLocked(n.id) ? '锁定' : '未锁定'}`)}
      </>
    );
  } else {
    const assetIds = new Set(all.map((n) => n.assetId));
    const faces = all.reduce((s, n) => s + (doc.assets.get(n.assetId)?.meta.faces ?? 0), 0);
    body = (
      <>
        {line('对象', `${all.length} 个实例`)}
        {line('资产', `${assetIds.size} 种`)}
        {line('总面数', faces.toLocaleString())}
      </>
    );
  }
  return (
    <Section title="对象信息" defaultOpen={false}>
      {body}
    </Section>
  );
}

// ---------- 面板壳 ----------
export function ParamPanel() {
  useThrottledRev();
  const { all, editable, lockedCount } = panelTargets(doc);

  // 显示来源:可编辑集(与 gizmo 枢轴同口径);全锁定时退化为全集只读展示(裁决 1)
  const show = editable.length ? editable : all;
  const readOnly = editable.length === 0 && all.length > 0;

  const sel = doc.selection;
  const title = !all.length
    ? '场景设置'
    : sel.size === 1
      ? (() => {
          const n = doc.nodes.get([...sel][0]);
          return n?.kind === 'group' ? `${n.name}(组 · ${all.length} 个成员)` : (n?.name ?? '');
        })()
      : `已选 ${sel.size} 项 · ${all.length} 个对象`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: PANEL_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '9px 10px',
          fontSize: 12,
          fontWeight: 600,
          color: '#e8e8ea',
          borderBottom: `1px solid ${BORDER}`,
          flex: 'none',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={title}
      >
        {title}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {!all.length ? (
          <SceneSettings />
        ) : (
          <>
            <TransformSection show={show} edit={editable} readOnly={readOnly} />
            <MaterialSection show={show} edit={editable} readOnly={readOnly} />
            <InfoSection all={all} />
          </>
        )}
      </div>
      {lockedCount > 0 && (
        // PANEL 边界 1:底部常驻提示,不随分组折叠消失
        <div
          style={{
            flex: 'none',
            padding: '6px 10px',
            fontSize: 11,
            color: AMBER,
            background: '#2e2a22',
            borderTop: `1px solid ${BORDER}`,
          }}
        >
          {readOnly ? '所选对象均已锁定,树内解锁后可编辑' : `编辑将跳过 ${lockedCount} 个锁定对象`}
        </div>
      )}
    </div>
  );
}
