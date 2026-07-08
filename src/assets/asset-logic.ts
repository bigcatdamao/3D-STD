// 资产面板纯逻辑(T11)。条目状态机的单一投影:
//   解析中/失败 来自导入队列视图(与视口右上状态条同源,AST-02「解析中」);
//   就绪/失效 来自内核资产表;done/canceled 的队列条目不进网格(done 已化身资产)。
// 与 UI 解耦以接受单元测试(与 tree-logic / panel-logic 同一惯例)。

import type { SceneDocument } from '../kernel/scene';
import type { Asset } from '../kernel/types';
import type { ImportJobView } from '../state/store';
import { isDemoAsset } from './persist';

export interface AssetTile {
  kind: 'asset' | 'job';
  id: string; // assetId 或 jobId
  name: string;
  source: 'import' | 'ai';
  state: 'parsing' | 'ready' | 'failed' | 'expired';
  thumb: string | null;
  faces?: number;
  sizeText?: string; // 包围盒毫米尺寸
  unit?: string;
  watertight?: boolean | null;
  materialMissing?: boolean;
  createdAt?: number;
  demo?: boolean; // 演示夹具:可放置、不落库、不可删改
  unsaved?: boolean; // AST-04 超限拒写,仅存活本会话
  pct?: number; // parsing 进度
  phaseText?: string;
  errorText?: string;
  retryable?: boolean;
}

const mm = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

export function sizeTextOf(meta: Asset['meta']): string {
  const { min, max } = meta.bbox;
  return `${mm(max[0] - min[0])} × ${mm(max[1] - min[1])} × ${mm(max[2] - min[2])} mm`;
}

/** 网格条目投影:进行中任务在最上(入队序),资产按入库时间倒序,演示夹具(无时间戳)垫底 */
export function buildTiles(
  assets: Iterable<Asset>,
  jobs: ImportJobView[],
  thumbOf: (id: string) => string | null,
  unsavedIds: Iterable<string>,
): AssetTile[] {
  const unsaved = new Set(unsavedIds);
  const tiles: AssetTile[] = [];
  for (const j of jobs) {
    if (j.phase === 'queued' || j.phase === 'running') {
      tiles.push({
        kind: 'job',
        id: j.id,
        name: j.name,
        source: 'import',
        state: 'parsing',
        thumb: j.thumb ?? null,
        pct: j.pct,
        phaseText: j.phaseText,
      });
    } else if (j.phase === 'failed') {
      tiles.push({
        kind: 'job',
        id: j.id,
        name: j.name,
        source: 'import',
        state: 'failed',
        thumb: null,
        errorText: j.error?.message ?? '解析失败',
        retryable: j.error?.retryable ?? false,
      });
    }
    // done/canceled:不进网格(done 已成为资产条目)
  }
  const ready: AssetTile[] = [];
  for (const a of assets) {
    ready.push({
      kind: 'asset',
      id: a.id,
      name: a.name,
      source: a.source,
      state: a.state === 'expired' ? 'expired' : 'ready',
      thumb: thumbOf(a.id),
      faces: a.meta.faces,
      sizeText: sizeTextOf(a.meta),
      unit: a.meta.unitChoice,
      watertight: a.meta.watertight,
      materialMissing: a.meta.materialMissing,
      createdAt: a.meta.createdAt,
      demo: isDemoAsset(a.id),
      unsaved: unsaved.has(a.id),
    });
  }
  ready.sort((x, y) => (y.createdAt ?? -1) - (x.createdAt ?? -1) || x.name.localeCompare(y.name, 'zh'));
  return [...tiles, ...ready];
}

/** 级联删除信息(AST-03):列出受影响实例。项目维度在 T17 项目化后补充(当前即「当前场景」) */
export function cascadeInfo(d: SceneDocument, assetId: string): { count: number; names: string[] } {
  const names: string[] = [];
  for (const n of d.nodes.values()) if (n.kind === 'instance' && n.assetId === assetId) names.push(n.name);
  return { count: names.length, names };
}

/** 删除是否需要确认:就绪资产需级联确认(AST-03);失败/失效条目无确认直接移除(AST 边界 5) */
export const needsDeleteConfirm = (state: AssetTile['state']) => state === 'ready';

/** 条目悬停摘要(AST-02 元数据;详情弹层属 AST-06/P1,以 tooltip 先行) */
export function tileTooltip(t: AssetTile): string {
  if (t.kind === 'job') return t.state === 'failed' ? `${t.name}\n${t.errorText}` : `${t.name}\n${t.phaseText}`;
  const lines = [
    t.name,
    `${t.sizeText} · ${(t.faces ?? 0).toLocaleString()} 面`,
    `来源:${t.source === 'ai' ? 'AI 生成' : '导入'} · 单位:${t.unit}`,
    `水密:${t.watertight === null || t.watertight === undefined ? '未检' : t.watertight ? '是' : '否'}`,
  ];
  if (t.materialMissing) lines.push('材质缺失(OBJ 无 MTL,已用默认材质)');
  if (t.createdAt) lines.push(`入库:${new Date(t.createdAt).toLocaleString()}`);
  if (t.state === 'expired') lines.push('已失效:本地几何丢失,元数据保留');
  if (t.unsaved) lines.push('未保存:本地存储已满,清理后自动补存');
  if (t.demo) lines.push('演示对象:每次启动重建,不落库');
  return lines.join('\n');
}
