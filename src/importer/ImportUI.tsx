// 导入 UI(T10)。四件套:
//  1) useImportDrop —— 视口拖放入口(IMP-02 的「拖入视口 = 入库+建实例」最终语义);
//  2) ImportStatusStrip —— 解析占位条目:进度可见、失败分类文案 + 重试/移除,不静默消失(IMP-08);
//  3) UnitDialog —— IMP-05 单位确认(mm/cm/inch/m),切换即在床上实时换算;
//  4) GhostPreview —— 确认前的床上幽灵体(Canvas 内),未入库未入栈的可视承诺。
// 工具栏「导入」按钮为 T10 临时入口(与拖放同语义);T11 资产面板就位后改绑「仅入库」(IMP-02)。

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useUi } from '../state/store';
import { ASSET_DRAG_MIME } from '../assets/AssetPanel';
import {
  cancelImport,
  cancelUnitAsk,
  confirmUnitAsk,
  dismissImport,
  ghostStore,
  placeFromLibrary,
  retryImport,
  startImport,
} from './ingest';
import { UNIT_FACTOR, UNIT_LABEL, fmtMm, sizeInMm, type UnitChoice } from './unit-infer';

const AMBER = '#ffb454';
const panel: React.CSSProperties = {
  background: '#26262e',
  border: '1px solid #34343e',
  borderRadius: 8,
  color: '#c9c9d1',
  fontSize: 12,
};
const btn: React.CSSProperties = {
  background: '#1b1b20',
  color: '#c9c9d1',
  border: '1px solid #34343e',
  borderRadius: 6,
  padding: '3px 8px',
  fontSize: 12,
  cursor: 'pointer',
};

// ---------- 1) 拖放入口 ----------

export function useImportDrop() {
  const setDrag = useUi((s) => s.setDragImport);
  return {
    onDragOver: (e: React.DragEvent) => {
      const types = [...e.dataTransfer.types];
      const kind = types.includes('Files') ? 'files' : types.includes(ASSET_DRAG_MIME) ? 'asset' : null;
      if (!kind) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDrag(kind);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setDrag(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      if (e.dataTransfer.files.length) {
        startImport(e.dataTransfer.files, 'viewport'); // IMP-02:拖入视口 = 入库+建实例
        return;
      }
      const assetId = e.dataTransfer.getData(ASSET_DRAG_MIME);
      if (assetId) placeFromLibrary(assetId); // AST-03:资产条目拖入视口 = 建实例(床中心+沉底)
    },
  };
}

export function DragHighlight() {
  useUi((s) => s.dragImport); // 订阅信号;数据经 getState 直读(SSR 走 server snapshot,selector 只见初值)
  const on = useUi.getState().dragImport;
  if (!on) return null;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 6,
        border: `2px dashed ${AMBER}`,
        borderRadius: 10,
        background: 'rgba(255,180,84,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: AMBER,
        fontSize: 14,
        pointerEvents: 'none',
        zIndex: 30,
      }}
    >
      {on === 'asset' ? '松开以放置实例(床中心 + 自动沉底)' : '松开以导入并放置(GLB / glTF / STL / OBJ)'}
    </div>
  );
}

/** 工具栏「导入」(T11 起改绑「仅入库」,IMP-02):文件选择器入库不放置;拖入视口才直接落床 */
export function ImportButton({
  style,
  className,
  target = 'library',
  label = '导入',
}: {
  style?: React.CSSProperties;
  className?: string;
  target?: 'library' | 'viewport';
  label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const directPlace = target === 'viewport';
  return (
    <>
      <button
        className={className}
        style={style}
        title={directPlace ? '导入模型并直接放置到打印床' : '导入文件到资产库(不放置);直接拖文件进视口 = 导入并放置'}
        onClick={() => ref.current?.click()}
      >
        {label}
      </button>
      <input
        ref={ref}
        type="file"
        multiple
        accept=".glb,.gltf,.stl,.obj"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) startImport(e.target.files, target);
          e.target.value = ''; // 允许连续选择同一文件
        }}
      />
    </>
  );
}

// ---------- 2) 导入状态条 ----------

const PHASE_COLOR: Record<string, string> = {
  queued: '#8b8b93',
  running: '#6aa9e8',
  done: '#5dcaa5',
  failed: '#f09595',
  canceled: '#8b8b93',
};

export function ImportStatusStrip() {
  useUi((s) => s.importJobs); // 订阅信号;数据经 getState 直读(与 TreeTab 的 rev 订阅同一惯例)
  const jobs = useUi.getState().importJobs;
  if (jobs.length === 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: 52,
        right: 10,
        width: 240,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        zIndex: 25,
      }}
    >
      {jobs.map((j) => (
        <div key={j.id} style={{ ...panel, padding: '7px 9px', pointerEvents: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {j.thumb ? (
              <img
                src={j.thumb}
                alt=""
                width={30}
                height={30}
                style={{ borderRadius: 5, background: '#1b1b20', flex: '0 0 auto' }}
              />
            ) : (
              <span style={{ width: 30, textAlign: 'center', flex: '0 0 auto' }}>
                {j.phase === 'failed' ? '⚠️' : '📦'}
              </span>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  color: '#e8e8ea',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={j.name}
              >
                {j.name}
              </div>
              <div style={{ color: PHASE_COLOR[j.phase], marginTop: 1 }}>
                {j.phase === 'failed' ? j.error?.message : j.phaseText}
              </div>
            </div>
            {(j.phase === 'queued' || j.phase === 'running') && (
              <button style={btn} onClick={() => cancelImport(j.id)} title="取消解析(边界 3)">
                ✕
              </button>
            )}
          </div>
          {j.phase === 'running' && (
            <div style={{ height: 4, background: '#1b1b20', borderRadius: 3, marginTop: 6 }}>
              <div
                style={{
                  height: '100%',
                  width: `${j.pct}%`,
                  background: '#6aa9e8',
                  borderRadius: 3,
                  transition: 'width .25s',
                }}
              />
            </div>
          )}
          {j.phase === 'failed' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
              {j.error?.retryable && (
                <button style={btn} onClick={() => retryImport(j.id)}>
                  重试
                </button>
              )}
              <button style={btn} onClick={() => dismissImport(j.id)}>
                移除
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- 3) 单位确认对话框(IMP-05) ----------

export function UnitDialog() {
  useUi((s) => s.unitAsk); // 订阅信号;数据经 getState 直读
  const ask = useUi.getState().unitAsk;
  const setAsk = useUi.getState().setUnitAsk;
  const [unit, setUnit] = useState<UnitChoice>(ask?.unit ?? 'mm'); // 惰性初值:SSR/首帧即对齐推荐
  useEffect(() => {
    if (ask) setUnit(ask.unit); // 同组件跨任务复用时同步(对话框关-开之间不卸载)
  }, [ask?.jobId]);
  if (!ask) return null;

  const pick = (u: UnitChoice) => {
    setUnit(u);
    setAsk({ ...ask, unit: u }); // 驱动床上幽灵实时换算
  };
  const size = sizeInMm(ask.bboxRaw, unit);
  const overBed = size[0] > 256 || size[1] > 256 || size[2] > 256;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(12,12,15,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <div style={{ ...panel, width: 316, padding: 16 }}>
        <div style={{ color: '#e8e8ea', fontSize: 13, fontWeight: 600 }}>确认「{ask.name}」的单位</div>
        <div style={{ marginTop: 6, lineHeight: 1.6 }}>
          该文件的尺寸数值落在常规打印范围之外,请确认建模单位——床上的半透明预览会随选择实时换算。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
          {(Object.keys(UNIT_FACTOR) as UnitChoice[]).map((u) => (
            <label
              key={u}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px',
                borderRadius: 7,
                border: `1px solid ${unit === u ? AMBER : '#34343e'}`,
                background: unit === u ? 'rgba(255,180,84,0.08)' : '#1b1b20',
                cursor: 'pointer',
              }}
            >
              <input type="radio" checked={unit === u} onChange={() => pick(u)} />
              <span style={{ color: '#e8e8ea', width: 84 }}>
                {UNIT_LABEL[u]}
                {u === ask.recommended && <span style={{ color: AMBER }}> ·推荐</span>}
              </span>
              <span style={{ marginLeft: 'auto', color: '#8b8b93' }}>
                {sizeInMm(ask.bboxRaw, u).map(fmtMm).join(' × ')} mm
              </span>
            </label>
          ))}
        </div>
        {overBed && (
          <div style={{ color: AMBER, marginTop: 10 }}>
            ⚠ 当前选择超出 256mm 床尺寸——仍可导入,床外问题只提示不拦截(C4)。
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button style={btn} onClick={cancelUnitAsk}>
            取消导入
          </button>
          <button
            style={{ ...btn, background: AMBER, color: '#1b1b20', border: `1px solid ${AMBER}`, fontWeight: 600 }}
            onClick={() => confirmUnitAsk(unit)}
          >
            确认导入
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 4) 床上幽灵预览(Canvas 内) ----------

export function GhostPreview() {
  useUi((s) => s.unitAsk); // 订阅信号;数据经 getState 直读
  const ask = useUi.getState().unitAsk;
  if (!ask || !ghostStore.geo) return null;
  const f = UNIT_FACTOR[ask.unit];
  return (
    <group position={[ask.slotX, 0, -ask.bboxRaw.min[2] * f]} scale={[f, f, f]}>
      <mesh geometry={ghostStore.geo}>
        <meshStandardMaterial color={AMBER} transparent opacity={0.42} depthWrite={false} />
      </mesh>
      <mesh geometry={ghostStore.geo}>
        <meshBasicMaterial color={AMBER} wireframe transparent opacity={0.22} />
      </mesh>
    </group>
  );
}
