// 导出状态桥(T15)—— 导出对话框与内核/检查系统之间的唯一通道。
// 流程(CHK-02 自动触发分支 + CHK-08 错误级确认,均遵循 C4「只提示,不拦截」):
//   ① 解析导出范围(全部可见 / 仅选中;隐藏优先排除,边界 4);
//   ② 闸门:检查报告新鲜(phase=done 且未过期)则直接复用,否则自动发起一轮检查并等待
//      —— 检查是场景级公共动作,导出触发的这一轮与手动检查完全同源(结果面板照常更新);
//   ③ 结算:导出集内的错误级条目 / 超时未检对象 / 被排除对象,任一非空 → 确认框列明,
//      确认后放行(绝不禁用导出);全空 → 直接写文件;
//   ④ 写出:合并单 STL 或逐对象 zip,浏览器下载。导出不改文档、不入历史栈(C1 第三类)。

import { create } from 'zustand';
import { useEffect as useReactEffect, useState as useReactState } from 'react';
import type { CheckIssue } from '../check/check-core';
import { liveIssues, reportIsStale, runPrintCheck, useCheck } from '../check/check-state';
import type { InstanceNode } from '../kernel/types';
import { doc, geometryRegistry, useUi } from '../state/store';
import {
  dedupeNames,
  extractGeometry,
  fmtSize,
  sanitizeName,
  writeBinarySTL,
  zipStore,
  type ExportPart,
} from './export-core';

// ---------- store ----------

export type ExportScope = 'visible' | 'selected';
export type ExportMode = 'merged' | 'perObject';
export type ExportStage = 'options' | 'checking' | 'confirm';

export interface ExcludedItem {
  name: string;
  reason: string;
}

/** CHK-08 确认框负载:错误级条目 + 超时未检 + 范围排除(边界 4),全部如实列明 */
export interface ConfirmPayload {
  errors: CheckIssue[];
  unfinished: string[];
  excluded: ExcludedItem[];
}

interface ExportState {
  open: boolean;
  stage: ExportStage;
  scope: ExportScope;
  mode: ExportMode;
  baseName: string; // 下载文件基名(T17 起接项目名,PROJ-05;M1 用固定默认)
  confirm: ConfirmPayload | null;
  pendingIds: string[]; // 确认框挂起的导出集(确认时按现存性重过滤)
  setScope: (s: ExportScope) => void;
  setMode: (m: ExportMode) => void;
  setBaseName: (n: string) => void;
}

export const DEFAULT_BASE_NAME = '3d-std-场景';

export const useExport = create<ExportState>()((set) => ({
  open: false,
  stage: 'options',
  scope: 'visible',
  mode: 'merged',
  baseName: DEFAULT_BASE_NAME,
  confirm: null,
  pendingIds: [],
  setScope: (scope) => set({ scope }),
  setMode: (mode) => set({ mode }),
  setBaseName: (baseName) => set({ baseName }),
}));

/** SSR 安全全量订阅(与 useCheckSnapshot 同 idiom) */
export function useExportSnapshot(): ExportState {
  const [s, setS] = useReactState(() => useExport.getState());
  useReactEffect(() => {
    setS(useExport.getState());
    return useExport.subscribe(setS);
  }, []);
  return s;
}

// ---------- 范围解析 ----------

/** 可导出对象 = 有效可见(C7:隐藏不导出)且资产就绪的实例。空 = 导出置灰(CHK 边界 3) */
export function exportableVisible(): InstanceNode[] {
  const out: InstanceNode[] = [];
  for (const n of doc.nodes.values()) {
    if (n.kind !== 'instance') continue;
    if (!doc.effectiveVisible(n.id)) continue;
    if (doc.assets.get(n.assetId)?.state !== 'ready') continue;
    out.push(n);
  }
  return out;
}

/** 仅选中范围:组展开为全部后代实例;隐藏优先排除并留名单(CHK 边界 4「确认框注明」)。
 *  锁定不排除 —— 锁定 = 不可变换,不是不可导出(C7 三状态正交)。 */
export function resolveSelectedScope(): { included: InstanceNode[]; excluded: ExcludedItem[] } {
  const seen = new Map<string, InstanceNode>();
  const excludedIds = new Set<string>();
  const excluded: ExcludedItem[] = [];
  for (const id of doc.selection) {
    const n = doc.nodes.get(id);
    if (!n) continue;
    const pool = n.kind === 'instance' ? [n.id] : doc.descendants(n.id);
    for (const pid of pool) {
      const p = doc.nodes.get(pid);
      if (!p || p.kind !== 'instance' || seen.has(pid) || excludedIds.has(pid)) continue;
      if (!doc.effectiveVisible(pid)) {
        excludedIds.add(pid);
        excluded.push({ name: p.name, reason: '已隐藏(C7:隐藏不导出)' });
        continue;
      }
      if (doc.assets.get(p.assetId)?.state !== 'ready') {
        excludedIds.add(pid);
        excluded.push({ name: p.name, reason: '资产未就绪' });
        continue;
      }
      seen.set(pid, p);
    }
  }
  return { included: [...seen.values()], excluded };
}

// ---------- 对话框开合 ----------

export function openExport() {
  // 打开时若已有选中实例,默认范围仍为「全部可见」(CHK-07 措辞的默认序);选项由用户切换
  useExport.setState({ open: true, stage: 'options', confirm: null, pendingIds: [] });
}

export function closeExport() {
  cancelGate();
  useExport.setState({ open: false, stage: 'options', confirm: null, pendingIds: [] });
}

// ---------- 闸门(CHK-02 导出前自动检查) ----------

let gateSeq = 0; // 令牌:取消/重开后过期回调不再生效
let gateUnsub: (() => void) | null = null;

/** 「取消/返回」= 作废在途闸门;已发起的检查照常跑完(它就是一轮普通检查,结果面板照常收) */
export function cancelGate() {
  gateSeq++;
  gateUnsub?.();
  gateUnsub = null;
  if (useExport.getState().stage !== 'options') {
    useExport.setState({ stage: 'options', confirm: null, pendingIds: [] });
  }
}

/** 主入口:点「导出」。范围解析 → 报告新鲜则直接结算,否则自动检查后结算 */
export function beginExport(): void {
  const st = useExport.getState();
  const { included, excluded } =
    st.scope === 'selected'
      ? resolveSelectedScope()
      : { included: exportableVisible(), excluded: [] as ExcludedItem[] };
  if (!included.length) {
    useUi.getState().setToast('无可导出对象(范围内对象为空或全部隐藏)');
    return;
  }

  const seq = ++gateSeq;
  let settled = false;
  const evaluate = () => {
    if (settled || gateSeq !== seq) return;
    settled = true;
    gateUnsub?.();
    gateUnsub = null;
    evaluateGate(included, excluded);
  };

  const cs = useCheck.getState();
  if (cs.phase === 'done' && !reportIsStale()) {
    evaluate(); // 新鲜报告直接复用,不重跑(检查有成本,结论未失效)
    return;
  }
  useExport.setState({ stage: 'checking' });
  if (cs.phase !== 'running') runPrintCheck(); // 已在跑则搭现车等结果
  gateUnsub = useCheck.subscribe((s2) => {
    if (s2.phase === 'done') evaluate();
  });
  if (useCheck.getState().phase === 'done') evaluate(); // 订阅间隙完成的竞态兜底
}

/** 结算:导出集内错误级 / 未检 / 排除项,任一非空 → 确认框(CHK-08);全空 → 直接导出 */
function evaluateGate(included: InstanceNode[], excluded: ExcludedItem[]) {
  const ids = new Set(included.map((n) => n.id));
  const errors = liveIssues().filter((i) => i.level === 'error' && ids.has(i.instanceId));
  const unfinished = useCheck
    .getState()
    .unfinished.filter((u) => ids.has(u.id))
    .map((u) => u.name);
  if (errors.length || unfinished.length || excluded.length) {
    useExport.setState({
      stage: 'confirm',
      confirm: { errors, unfinished, excluded },
      pendingIds: [...ids],
    });
    return;
  }
  doExport(included);
}

/** 确认框「仍要导出」(C4 放行)。挂起集按现存性重过滤(确认框开着时对象可能被删) */
export function confirmProceed() {
  const ids = useExport.getState().pendingIds;
  const included = ids
    .map((id) => doc.nodes.get(id))
    .filter((n): n is InstanceNode => !!n && n.kind === 'instance' && doc.effectiveVisible(n.id));
  if (!included.length) {
    useUi.getState().setToast('导出集已为空(对象被删除或隐藏)');
    closeExport();
    return;
  }
  doExport(included);
}

// ---------- 写出与下载 ----------

type SaveFn = (blob: Blob, filename: string) => void;

function defaultSave(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

let saveImpl: SaveFn = defaultSave;
/** 测试钩:替换浏览器下载 */
export function _injectSave(fn: SaveFn) {
  saveImpl = fn;
}

function doExport(included: InstanceNode[]) {
  const st = useExport.getState();
  const base = sanitizeName(st.baseName) || DEFAULT_BASE_NAME;

  const parts: { name: string; part: ExportPart }[] = [];
  for (const n of included) {
    const geo = extractGeometry(geometryRegistry.get(n.assetId));
    if (!geo) continue; // 无几何(注册表缺失)静默跳过;全缺在下方兜底
    parts.push({ name: n.name, part: { ...geo, transform: structuredClone(n.transform) } });
  }
  if (!parts.length) {
    useUi.getState().setToast('导出失败:范围内对象缺少几何数据');
    closeExport();
    return;
  }

  let blob: Blob;
  let filename: string;
  if (st.mode === 'merged') {
    blob = new Blob([writeBinarySTL(parts.map((p) => p.part))], { type: 'model/stl' });
    filename = `${base}.stl`;
  } else {
    const names = dedupeNames(parts.map((p) => sanitizeName(p.name) || 'model'));
    const files = parts.map((p, i) => ({
      name: `${names[i]}.stl`,
      data: new Uint8Array(writeBinarySTL([p.part])),
    }));
    blob = new Blob([zipStore(files)], { type: 'application/zip' });
    filename = `${base}.zip`;
  }

  saveImpl(blob, filename);
  useExport.setState({ open: false, stage: 'options', confirm: null, pendingIds: [] });
  useUi
    .getState()
    .setToast(`已导出 ${parts.length} 个对象 → ${filename}(${fmtSize(blob.size)},二进制 STL · mm)`);
}
