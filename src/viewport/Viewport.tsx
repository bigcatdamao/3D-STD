// 视口(T5 汇总):世界 + 相机 + 选择。工具栏与状态条为视口覆盖层;
// 状态条暴露「选中数 / 历史条数与位置」——验收样例的可观测口径直接在界面上读。

import { Canvas } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import {
  BED_PRESETS,
  bootstrapDemoScene,
  dispatch,
  doc,
  sendCam,
  useUi,
} from '../state/store';
import { Bed } from './Bed';
import { CameraRig } from './CameraRig';
import { SceneInstances } from './SceneInstances';
import { interactionState, useViewportInteraction } from './interaction';

bootstrapDemoScene();

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
    <div
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        right: 10,
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      <div style={{ display: 'flex', gap: 6, pointerEvents: 'auto' }}>
        <button style={btn} onClick={() => setOrtho(!ortho)} title="快捷键 5">
          {ortho ? '正交' : '透视'}
        </button>
        <button style={btn} onClick={() => sendCam({ kind: 'preset', view: 'top' })} title="快捷键 1">顶</button>
        <button style={btn} onClick={() => sendCam({ kind: 'preset', view: 'front' })} title="快捷键 2">前</button>
        <button style={btn} onClick={() => sendCam({ kind: 'preset', view: 'side' })} title="快捷键 3">侧</button>
        <button style={btn} onClick={() => sendCam({ kind: 'preset', view: 'iso' })} title="快捷键 0">轴测</button>
        <button style={btn} onClick={() => sendCam({ kind: 'focus' })} title="快捷键 F">聚焦</button>
        <button style={btn} onClick={() => sendCam({ kind: 'home' })} title="快捷键 Home">复位</button>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, pointerEvents: 'auto' }}>
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
      style={{
        position: 'absolute',
        left: 10,
        bottom: 8,
        fontSize: 11,
        color: '#8b8b93',
        background: 'rgba(20,20,23,0.72)',
        padding: '3px 8px',
        borderRadius: 6,
        pointerEvents: 'none',
      }}
    >
      选中 {sel} · 历史 {h.position}/{h.length}
      {'  ·  '}左键选/框选/按住拖 · 右键旋转 · 中键平移 · 滚轮缩放 · 1/2/3/0 视角 · F 聚焦 · Home 复位 · 5 投影 · Ctrl+A 全选 · Ctrl+Z 撤销
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
      switch (e.key) {
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

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        style={{ background: '#141417' }}
        onContextMenu={(e) => e.preventDefault()} // 右键归 orbit,屏蔽浏览器菜单
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[220, -160, 340]} intensity={1.15} />
        <directionalLight position={[-180, 200, 180]} intensity={0.35} />
        <CameraRig />
        <Bed bed={bed} />
        <SceneInstances />
        <InteractionBridge />
      </Canvas>
      <Toolbar />
      <MarqueeOverlay />
      <StatusBar />
    </div>
  );
}
