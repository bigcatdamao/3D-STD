// 视口(T5 汇总):世界 + 相机 + 选择。工具栏与状态条为视口覆盖层;
// 状态条暴露「选中数 / 历史条数与位置」——验收样例的可观测口径直接在界面上读。

import { Canvas } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import {
  BED_PRESETS,
  dispatch,
  doc,
  expandToInstances,
  sendCam,
  useUi,
} from '../state/store';
import {
  DragHighlight,
  GhostPreview,
  ImportButton,
  ImportStatusStrip,
  UnitDialog,
  useImportDrop,
} from '../importer/ImportUI';
import { Bed } from './Bed';
import { CameraRig } from './CameraRig';
import { Gizmo } from './Gizmo';
import { SceneInstances } from './SceneInstances';
import { CheckHighlight } from '../check/CheckHighlight';
import { RepairPreviewMesh } from '../repair/RepairPreviewMesh';
import { worldBBoxOfInstance } from './gizmo-math';
import { interactionState, useViewportInteraction } from './interaction';
import { PlaneCutPreview } from '../split/PlaneCutPreview';

function InteractionBridge() {
  useViewportInteraction();
  return null;
}

const btn: React.CSSProperties = {
  background: '#26262e',
  color: '#c9c9d1',
  border: '1px solid #34343e',
  borderRadius: 6,
  padding: '4px 9px',
  fontSize: 12,
  cursor: 'pointer',
};

function Toolbar() {
  const ortho = useUi((s) => s.ortho);
  const setOrtho = useUi((s) => s.setOrtho);
  const bed = useUi((s) => s.bed);
  const setBed = useUi((s) => s.setBed);
  const [custom, setCustom] = useState(false);

  const presetIdx = BED_PRESETS.findIndex(
    (p) => p.bed.x === bed.x && p.bed.y === bed.y && p.bed.z === bed.z,
  );

  return (
    <div className="viewport-toolbar">
      <div className="viewport-toolbar__views">
        {/* T10 临时入口:文件选择器与拖放同语义(入库+建实例);T11 资产面板就位后改绑「仅入库」(IMP-02) */}
        <ImportButton className="viewport-tool" style={{ ...btn, borderColor: '#ffb454', color: '#ffb454' }} />
        <button style={btn} onClick={() => setOrtho(!ortho)} title="快捷键 5">
          {ortho ? '正交' : '透视'}
        </button>
        <button className="viewport-tool--secondary" style={btn} onClick={() => sendCam({ kind: 'preset', view: 'top' })} title="快捷键 1">顶</button>
        <button className="viewport-tool--secondary" style={btn} onClick={() => sendCam({ kind: 'preset', view: 'front' })} title="快捷键 2">前</button>
        <button className="viewport-tool--secondary" style={btn} onClick={() => sendCam({ kind: 'preset', view: 'side' })} title="快捷键 3">侧</button>
        <button style={btn} onClick={() => sendCam({ kind: 'preset', view: 'iso' })} title="快捷键 0">轴测</button>
        <button style={btn} onClick={() => sendCam({ kind: 'focus' })} title="快捷键 F">聚焦</button>
        <button className="viewport-tool--secondary" style={btn} onClick={() => sendCam({ kind: 'home' })} title="快捷键 Home">复位</button>
      </div>
      <TransformTools />
      <div className="viewport-toolbar__bed">
        <select
          style={{ ...btn, appearance: 'auto' }}
          value={custom || presetIdx < 0 ? 'custom' : String(presetIdx)}
          onChange={(e) => {
            if (e.target.value === 'custom') {
              setCustom(true);
            } else {
              setCustom(false);
              setBed(BED_PRESETS[Number(e.target.value)].bed);
            }
          }}
          title="打印床尺寸(VIEW-01)"
        >
          {BED_PRESETS.map((p, i) => (
            <option key={p.label} value={String(i)}>
              床 {p.label}
            </option>
          ))}
          <option value="custom">自定义…</option>
        </select>
        {(custom || presetIdx < 0) && (
          <input
            style={{ ...btn, width: 64, cursor: 'text' }}
            type="number"
            min={100}
            max={1000}
            step={10}
            value={bed.x}
            onChange={(e) => {
              const v = Math.max(100, Math.min(1000, Number(e.target.value) || 256));
              setBed({ x: v, y: v, z: v });
            }}
            title="边长 mm(方床)"
          />
        )}
      </div>
    </div>
  );
}

/** T6 工具组:W/E/R 三模式切换 + 「沉底」一等按钮(VIEW-05/06) */
function TransformTools() {
  useUi((s) => s.rev); // 选中集变化 → 沉底可用态刷新
  const mode = useUi((s) => s.gizmoMode);
  const setMode = useUi((s) => s.setGizmoMode);
  const targets = expandToInstances(doc.selection);

  const modeBtn = (active: boolean): React.CSSProperties => ({
    ...btn,
    ...(active ? { borderColor: '#ffb454', color: '#ffb454', background: '#2e2a22' } : {}),
  });

  const onDrop = () => {
    const ids = expandToInstances(doc.selection).map((n) => n.id);
    if (!ids.length) return;
    // VIEW-06:底面 Z 归零。zMin 由文档数据推导(资产 bbox × 当前 TRS),不依赖渲染帧
    dispatch((d) =>
      d.dropToBed(ids, (inst) =>
        worldBBoxOfInstance(inst.transform, d.assets.get(inst.assetId)!.meta.bbox).min.z,
      ),
    );
  };

  return (
    <div className="viewport-toolbar__transform">
      <button style={modeBtn(mode === 'translate')} onClick={() => setMode('translate')} title="快捷键 W">移动</button>
      <button style={modeBtn(mode === 'rotate')} onClick={() => setMode('rotate')} title="快捷键 E">旋转</button>
      <button style={modeBtn(mode === 'scale')} onClick={() => setMode('scale')} title="快捷键 R">缩放</button>
      <button
        style={{
          ...btn,
          ...(targets.length
            ? { background: '#ffb454', borderColor: '#ffb454', color: '#1b1b20', fontWeight: 600 }
            : { opacity: 0.45, cursor: 'default' }),
        }}
        disabled={!targets.length}
        onClick={onDrop}
        title="选中对象底面 Z 归零(VIEW-06)"
      >
        ⬇ 沉底
      </button>
    </div>
  );
}

/** VIEW-05 增量浮标:跟随光标外显当前拖拽增量;Ctrl 吸附时数值按步进跳变 */
function GizmoHud() {
  const hud = useUi((s) => s.hud);
  if (!hud) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: hud.x + 16,
        top: hud.y + 14,
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
        color: '#1b1b20',
        background: '#ffb454',
        padding: '2px 8px',
        borderRadius: 5,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        fontWeight: 600,
      }}
    >
      {hud.text}
    </div>
  );
}

function MarqueeOverlay() {
  const m = useUi((s) => s.marquee);
  if (!m) return null;
  const x = Math.min(m.x0, m.x1);
  const y = Math.min(m.y0, m.y1);
  const w = Math.abs(m.x1 - m.x0);
  const h = Math.abs(m.y1 - m.y0);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        border: '1px solid #ffb454',
        background: 'rgba(255,180,84,0.10)',
        pointerEvents: 'none',
      }}
    />
  );
}

function StatusBar() {
  useUi((s) => s.rev);
  const sel = doc.selection.size;
  const h = doc.history;
  return (
    <div
      className="viewport-status-bar"
      title="左键选择或拖动 · 右键旋转 · 中键平移 · 滚轮缩放 · W/E/R 变换 · 1/2/3/0 视角 · F 聚焦 · Home 复位 · Ctrl+A 全选 · Ctrl+Z 撤销 · Del 删除 · Esc 取消"
    >
      <span>选中 {sel} · 历史 {h.position}/{h.length}</span>
      <span className="viewport-status-bar__shortcuts">W/E/R 变换 · F 聚焦 · Ctrl+Z 撤销</span>
    </div>
  );
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function Viewport() {
  const setOrtho = useUi((s) => s.setOrtho);

  // 全局快捷键(VIEW-03/04)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        dispatch((d) => d.selectAll()); // 跳过锁定(VIEW-04)
        return;
      }
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        dispatch((d) => (e.shiftKey ? d.history.redo() : d.history.undo()));
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        dispatch((d) => d.history.redo());
        return;
      }
      if (mod) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // TREE-04 删除:多选一步;组 = 组及内容整树(TREE 边界 1);拖拽/交互中不响应
        if (!interactionState.active && doc.selection.size) {
          e.preventDefault();
          dispatch((d) => d.removeNodes(d.topMost(d.selection)));
        }
        return;
      }
      switch (e.key) {
        case 'w': case 'W': useUi.getState().setGizmoMode('translate'); break;
        case 'e': case 'E': useUi.getState().setGizmoMode('rotate'); break;
        case 'r': case 'R': useUi.getState().setGizmoMode('scale'); break;
        case '1': sendCam({ kind: 'preset', view: 'top' }); break;
        case '2': sendCam({ kind: 'preset', view: 'front' }); break;
        case '3': sendCam({ kind: 'preset', view: 'side' }); break;
        case '0': sendCam({ kind: 'preset', view: 'iso' }); break;
        case '5': setOrtho(!useUi.getState().ortho); break;
        case 'f': case 'F': sendCam({ kind: 'focus' }); break;
        case 'Home': sendCam({ kind: 'home' }); break;
        case 'Escape':
          // 拖动/框选中的 Esc 归交互层(取消拖动);空闲时才是「清空选中」
          if (!interactionState.active && doc.selection.size) dispatch((d) => d.select([]));
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOrtho]);

  const bed = useUi((s) => s.bed);
  const dropProps = useImportDrop(); // IMP-02:拖入视口 = 入库 + 建实例(床中心 + 自动沉底)

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }} {...dropProps}>
      <Canvas
        style={{ background: '#141417' }}
        onCreated={({ gl }) => { gl.localClippingEnabled = true; }}
        onContextMenu={(e) => e.preventDefault()} // 右键归 orbit,屏蔽浏览器菜单
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[220, -160, 340]} intensity={1.15} />
        <directionalLight position={[-180, 200, 180]} intensity={0.35} />
        <CameraRig />
        <Bed bed={bed} />
        <SceneInstances />
        <CheckHighlight />
        <PlaneCutPreview />
        <RepairPreviewMesh />
        <GhostPreview />
        <Gizmo />
        <InteractionBridge />
      </Canvas>
      <Toolbar />
      <MarqueeOverlay />
      <GizmoHud />
      <StatusBar />
      <DragHighlight />
      <ImportStatusStrip />
      <UnitDialog />
    </div>
  );
}
