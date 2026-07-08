// 资产面板(T11)—— AST-01~04 全部 P0 + 边界 1/5 + IMP-02 的「仅入库」入口。
//
// 交互约定:
//   拖条目进视口 = 建实例(床中心 + 自动沉底,历史 +1);双击就绪条目 = 同语义快捷放置
//   拖文件进本面板 = 仅入库(不放置);头部「导入」按钮同语义(文件选择器)
//   ✎ = 重命名(库操作不入栈;实例名不受牵连,C2);🗑 = 删除,就绪资产弹级联确认
//   (列出受影响实例,AST-03),失败/失效条目无确认直接移除(边界 5)
//   底部常驻容量条(AST-04):80% 变琥珀;超限拒写的条目带「未保存」角标,清理后自动补存
//   IndexedDB 不可用 → 顶端常驻「本次会话的资产不会被保存」(边界 1)

import { useState } from 'react';
import { dispatch, doc, thumbRegistry, useUi } from '../state/store';
import { dismissImport, placeFromLibrary, retryImport, startImport } from '../importer/ingest';
import { AssetTile, buildTiles, cascadeInfo, needsDeleteConfirm, tileTooltip } from './asset-logic';
import { fmtBytes, STORAGE_WARN_RATIO } from './persist';

export const ASSET_DRAG_MIME = 'application/x-3dstd-asset';

const AMBER = '#ffb454';
const BORDER = '#2b2b31';
const btn: React.CSSProperties = {
  background: '#26262e',
  color: '#c9c9d1',
  border: '1px solid #34343e',
  borderRadius: 6,
  padding: '3px 8px',
  fontSize: 12,
  cursor: 'pointer',
};

const STATE_BADGE: Record<string, { text: string; color: string }> = {
  parsing: { text: '解析中', color: '#6aa9e8' },
  failed: { text: '失败', color: '#f09595' },
  expired: { text: '已失效', color: '#f09595' },
};

interface ConfirmState {
  assetId: string;
  name: string;
  count: number;
  names: string[];
}

export function AssetPanel() {
  useUi((s) => s.rev); // 文档版本:资产增删改名后重投影
  useUi((s) => s.importJobs); // 解析中/失败条目与状态条同源
  useUi((s) => s.storage); // 订阅信号;数据经 getState 直读(SSR 走 server snapshot,selector 只见初值)
  const storage = useUi.getState().storage;
  const setToast = useUi.getState().setToast;

  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [fileHover, setFileHover] = useState(false);

  const tiles = buildTiles(
    doc.assets.values(),
    useUi.getState().importJobs,
    (id) => thumbRegistry.get(id) ?? null,
    storage.unsavedIds,
  );
  const assetCount = tiles.filter((t) => t.kind === 'asset').length;

  // ---------- 删除(AST-03 级联确认 / 边界 5) ----------
  const requestDelete = (t: AssetTile) => {
    if (t.kind === 'job') {
      dismissImport(t.id);
      return;
    }
    if (!needsDeleteConfirm(t.state)) {
      // 失效条目:无实例引用(几何已失,建不了),直接移除
      dispatch((d) => d.removeAssetCascade(t.id));
      return;
    }
    const info = cascadeInfo(doc, t.id);
    setConfirm({ assetId: t.id, name: t.name, count: info.count, names: info.names });
  };
  const doDelete = () => {
    if (!confirm) return;
    dispatch((d) => d.removeAssetCascade(confirm.assetId));
    setConfirm(null);
  };

  // ---------- 仅入库的文件拖放(IMP-02) ----------
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setFileHover(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setFileHover(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setFileHover(false);
      if (e.dataTransfer.files.length) startImport(e.dataTransfer.files, 'library');
    },
  };

  const usageRatio = storage.capBytes > 0 ? storage.usedBytes / storage.capBytes : 0;
  const warn = usageRatio >= STORAGE_WARN_RATIO;

  return (
    <div
      {...dropProps}
      style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      {/* 会话模式常驻提示(AST 边界 1) */}
      {storage.mode === 'session' && (
        <div
          style={{
            flex: 'none',
            padding: '6px 10px',
            fontSize: 11,
            lineHeight: 1.5,
            color: AMBER,
            background: 'rgba(255,180,84,0.08)',
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          ⚠ 本次会话的资产不会被保存(浏览器存储不可用)
        </div>
      )}

      {/* 头部:仅入库入口 */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <LibraryImportButton />
        <span style={{ fontSize: 11, color: '#8b8b93', marginLeft: 'auto' }}>{assetCount} 项</span>
      </div>

      {/* 网格(AST-01) */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {tiles.length === 0 ? (
          <div style={{ color: '#8b8b93', fontSize: 12, textAlign: 'center', marginTop: 32, lineHeight: 1.8 }}>
            资产库为空
            <br />
            拖文件到这里仅入库,拖进视口则直接放置
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {tiles.map((t) => (
              <Tile
                key={t.id}
                t={t}
                renaming={renaming === t.id}
                onRename={() => setRenaming(t.id)}
                onRenameDone={(name) => {
                  setRenaming(null);
                  if (name !== null) dispatch((d) => d.renameAsset(t.id, name));
                }}
                onDelete={() => requestDelete(t)}
                onPlaceFail={() => setToast('该资产不可放置(解析中或已失效)')}
              />
            ))}
          </div>
        )}
      </div>

      {/* 容量条(AST-04):idb 模式常驻;80% 琥珀;有未保存项时给出清理引导 */}
      {storage.mode === 'idb' && (
        <div style={{ flex: 'none', padding: '7px 10px', borderTop: `1px solid ${BORDER}`, fontSize: 11 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: warn ? AMBER : '#8b8b93' }}>
            <span>本地存储</span>
            <span>
              {fmtBytes(storage.usedBytes)} / {fmtBytes(storage.capBytes)}
            </span>
          </div>
          <div style={{ height: 4, background: '#26262e', borderRadius: 3, marginTop: 4 }}>
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, usageRatio * 100)}%`,
                background: warn ? AMBER : '#5dcaa5',
                borderRadius: 3,
                transition: 'width .3s',
              }}
            />
          </div>
          {storage.unsavedIds.length > 0 && (
            <div style={{ color: '#f09595', marginTop: 4, lineHeight: 1.5 }}>
              {storage.unsavedIds.length} 项超出容量未保存——删除不需要的资产后将自动补存(不会自动淘汰旧资产)
            </div>
          )}
        </div>
      )}

      {/* 文件拖入高亮:仅入库语义的可视承诺 */}
      {fileHover && (
        <div
          style={{
            position: 'absolute',
            inset: 4,
            border: `2px dashed ${AMBER}`,
            borderRadius: 8,
            background: 'rgba(255,180,84,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: AMBER,
            fontSize: 12,
            textAlign: 'center',
            pointerEvents: 'none',
            zIndex: 10,
          }}
        >
          松开仅入库(不放置到床上)
        </div>
      )}

      {/* 级联删除确认(AST-03):列出受影响实例;项目维度 T17 项目化后补列 */}
      {confirm && (
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
          <div
            style={{
              width: 300,
              padding: 16,
              background: '#26262e',
              border: '1px solid #34343e',
              borderRadius: 8,
              color: '#c9c9d1',
              fontSize: 12,
            }}
          >
            <div style={{ color: '#e8e8ea', fontSize: 13, fontWeight: 600 }}>删除资产「{confirm.name}」?</div>
            <div style={{ marginTop: 8, lineHeight: 1.6 }}>
              {confirm.count > 0 ? (
                <>
                  当前场景 <b style={{ color: '#f09595' }}>{confirm.count}</b> 个实例将一并删除:
                  <div style={{ color: '#8b8b93', marginTop: 4 }}>
                    {confirm.names.slice(0, 5).join('、')}
                    {confirm.names.length > 5 ? ` 等 ${confirm.names.length} 项` : ''}
                  </div>
                </>
              ) : (
                '当前场景没有实例引用它。'
              )}
              <div style={{ color: '#8b8b93', marginTop: 6 }}>此操作可用 Ctrl+Z 撤销(本次会话内)。</div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button style={btn} onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                style={{ ...btn, background: '#f09595', color: '#1b1b20', border: '1px solid #f09595', fontWeight: 600 }}
                onClick={doDelete}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 头部「导入」:文件选择器,仅入库语义(IMP-02;工具栏按钮 T11 起同语义) */
function LibraryImportButton() {
  return (
    <label style={{ ...btn, borderColor: AMBER, color: AMBER, display: 'inline-block' }}>
      导入
      <input
        type="file"
        multiple
        accept=".glb,.gltf,.stl,.obj"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) startImport(e.target.files, 'library');
          e.currentTarget.value = '';
        }}
      />
    </label>
  );
}

function Tile({
  t,
  renaming,
  onRename,
  onRenameDone,
  onDelete,
  onPlaceFail,
}: {
  t: AssetTile;
  renaming: boolean;
  onRename: () => void;
  onRenameDone: (name: string | null) => void;
  onDelete: () => void;
  onPlaceFail: () => void;
}) {
  const [hover, setHover] = useState(false);
  const draggable = t.kind === 'asset' && t.state === 'ready';
  const badge = STATE_BADGE[t.state];

  return (
    <div
      title={tileTooltip(t)}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_DRAG_MIME, t.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={() => {
        if (t.kind !== 'asset') return;
        if (!placeFromLibrary(t.id)) onPlaceFail();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        background: '#26262e',
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        overflow: 'hidden',
        cursor: draggable ? 'grab' : 'default',
        opacity: t.state === 'expired' ? 0.65 : 1,
      }}
    >
      {/* 图区 */}
      <div
        style={{
          aspectRatio: '1 / 1',
          background: '#1b1b20',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        {t.thumb ? (
          <img src={t.thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} draggable={false} />
        ) : (
          <span style={{ fontSize: 26 }}>{t.state === 'failed' ? '⚠️' : '📦'}</span>
        )}
        {/* 来源角标(AST-01) */}
        {t.kind === 'asset' && (
          <span
            style={{
              position: 'absolute',
              top: 4,
              left: 4,
              fontSize: 10,
              padding: '1px 5px',
              borderRadius: 4,
              background: t.source === 'ai' ? 'rgba(106,169,232,0.2)' : 'rgba(93,202,165,0.15)',
              color: t.source === 'ai' ? '#6aa9e8' : '#5dcaa5',
            }}
          >
            {t.source === 'ai' ? 'AI' : '导入'}
          </span>
        )}
        {/* 状态角标(AST-02 状态机) */}
        {badge && (
          <span
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              fontSize: 10,
              padding: '1px 5px',
              borderRadius: 4,
              background: 'rgba(27,27,32,0.85)',
              color: badge.color,
            }}
          >
            {badge.text}
          </span>
        )}
        {t.unsaved && (
          <span
            style={{
              position: 'absolute',
              bottom: 4,
              right: 4,
              fontSize: 10,
              padding: '1px 5px',
              borderRadius: 4,
              background: 'rgba(240,149,149,0.18)',
              color: '#f09595',
            }}
          >
            未保存
          </span>
        )}
        {t.materialMissing && !t.unsaved && (
          <span
            style={{
              position: 'absolute',
              bottom: 4,
              right: 4,
              fontSize: 10,
              padding: '1px 5px',
              borderRadius: 4,
              background: 'rgba(255,180,84,0.15)',
              color: AMBER,
            }}
          >
            材质缺失
          </span>
        )}
        {/* 解析进度(与状态条同源) */}
        {t.state === 'parsing' && (
          <div style={{ position: 'absolute', left: 6, right: 6, bottom: 6 }}>
            <div style={{ height: 4, background: '#26262e', borderRadius: 3 }}>
              <div
                style={{
                  height: '100%',
                  width: `${t.pct ?? 0}%`,
                  background: '#6aa9e8',
                  borderRadius: 3,
                  transition: 'width .25s',
                }}
              />
            </div>
          </div>
        )}
        {/* 悬停操作 */}
        {hover && t.state !== 'parsing' && (
          <div style={{ position: 'absolute', bottom: 4, left: 4, display: 'flex', gap: 4 }}>
            {t.kind === 'asset' && !t.demo && t.state !== 'failed' && (
              <button style={{ ...btn, padding: '1px 6px' }} title="重命名(F2 同义)" onClick={onRename}>
                ✎
              </button>
            )}
            {t.kind === 'job' && t.retryable && (
              <button style={{ ...btn, padding: '1px 6px' }} title="重试解析" onClick={() => retryImport(t.id)}>
                ↻
              </button>
            )}
            {!t.demo && (
              <button
                style={{ ...btn, padding: '1px 6px' }}
                title={t.state === 'ready' ? '删除(级联确认)' : '移除(无确认)'}
                onClick={onDelete}
              >
                🗑
              </button>
            )}
          </div>
        )}
      </div>
      {/* 名区 */}
      <div style={{ padding: '5px 7px' }}>
        {renaming ? (
          <RenameInput initial={t.name} onDone={onRenameDone} />
        ) : (
          <>
            <div
              style={{
                fontSize: 11,
                color: t.state === 'failed' ? '#f09595' : '#e8e8ea',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {t.name}
            </div>
            <div style={{ fontSize: 10, color: '#8b8b93', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {t.state === 'parsing'
                ? t.phaseText
                : t.state === 'failed'
                  ? t.errorText
                  : `${((t.faces ?? 0) / 1).toLocaleString()} 面`}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => onDone(v.trim() ? v : null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(v.trim() ? v : null);
        if (e.key === 'Escape') onDone(null);
        e.stopPropagation();
      }}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        background: '#1b1b20',
        color: '#e8e8ea',
        border: `1px solid ${AMBER}`,
        borderRadius: 4,
        fontSize: 11,
        padding: '2px 4px',
      }}
    />
  );
}
