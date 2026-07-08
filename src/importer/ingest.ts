// 导入编排(主线程)—— 队列事件 → 单位裁决(IMP-05) → 内核入库(±落场)。
// T11 起三入口双语义(IMP-02):拖入视口 = 入库+建实例;拖入资产面板 / 文件选择器 = 仅入库。
//
// 单位三分支:
//   glTF        → 解码期已按规范米→毫米烘焙,直接入库,不询问;
//   静默 mm     → 最大边 ∈[10,400],直接入库 + 「可撤 toast」(重选单位);
//   弹确认      → 对象先以「幽灵预览」呈现在床上(未入库、未入栈),对话框切单位实时换算,
//                 确认才产生 addAsset + placeInstance;取消则无痕退场 —— 历史栈全程干净。
//
// 「重选单位」(静默 mm 的可撤路径):删除资产级联(可撤销的一步) + 用保留的原始顶点重开
// 确认对话框 → 重新入库。历史呈现为 [导入][删除资产][导入] 线性三步,不做任何栈内手术。

import * as THREE from 'three';
import { doc, dispatch, thumbRegistry, useUi, geometryRegistry } from '../state/store';
import type { UnitAskState } from '../state/store';
import { ImportQueue, type ImportJob } from './import-queue';
import {
  FACE_WARN_LIMIT,
  FAILURE_COPY,
  MAX_FILE_BYTES,
  ParseFailure,
  detectFormat,
} from './parse-core';
import type { WorkerReply } from './parse.worker';
import { UNIT_FACTOR, inferUnit, type UnitChoice } from './unit-infer';
import { renderThumbnail } from './thumbnail';

type OkReply = Extract<WorkerReply, { t: 'ok' }>;

/** IMP-02 三入口双语义(T11 定稿):拖入视口 = 入库+建实例;拖入资产面板 / 工具栏文件选择器 = 仅入库 */
export type ImportTarget = 'viewport' | 'library';
const jobTarget = new Map<string, ImportTarget>(); // jobId → 目标语义(贯穿单位裁决全程)

/** 落床横向错位:同批多件按槽位左右展开(单件恰为床中心,IMP-02 字面语义) */
export const BATCH_SLOT_SPACING = 60;
export const slotXOf = (slot: number, batchSize: number) =>
  (slot - (batchSize - 1) / 2) * BATCH_SLOT_SPACING;

/** 待裁决暂存:原始单位顶点在裁决/重选窗口内保留,窗口关闭即释放 */
interface PendingRaw {
  name: string;
  positions: Float32Array;
  normals: Float32Array | null;
  meta: OkReply['meta'];
  slotX: number;
  target: ImportTarget;
}
const rawStore = new Map<string, PendingRaw>(); // jobId → raw
const askWaitline: string[] = []; // 单位确认一次一件,余者排队(jobId)
const RAW_RETENTION_MS = 30_000; // 静默 mm 的重选窗口:超时释放原始顶点

/** 幽灵预览几何(原始单位),UnitDialog 打开期间由视口 GhostPreview 消费 */
export const ghostStore: { geo: THREE.BufferGeometry | null } = { geo: null };

// ---------- 队列装配 ----------

let queue: ImportQueue | null = null;

function ensureQueue(): ImportQueue {
  if (queue) return queue;
  queue = new ImportQueue(
    () =>
      new Worker(new URL('./parse.worker.ts', import.meta.url), {
        type: 'module',
      }) as unknown as import('./import-queue').WorkerLike,
    {
      onUpdate: (job) => syncJobView(job),
      onResult: (job, ok) => onParsed(job, ok),
    },
  );
  return queue;
}

/** 测试钩子:注入假队列 */
export function _injectQueue(q: ImportQueue) {
  queue = q;
}

function syncJobView(job: ImportJob, thumb?: string | null) {
  useUi.getState().upsertImportJob({
    id: job.id,
    name: job.name,
    phase: job.phase,
    pct: job.pct,
    phaseText: job.phaseText,
    error: job.error,
    thumb,
  });
  // 完成/取消条目短暂停留后自动离场;失败条目常驻等待用户处置(IMP-08)
  if (job.phase === 'done' || job.phase === 'canceled') {
    const id = job.id;
    setTimeout(() => {
      useUi.getState().dropImportJob(id);
      queue?.remove(id);
    }, job.phase === 'done' ? 6000 : 2500);
  }
}

// ---------- 入口(IMP-08:入口即分类,失败挂条目不静默消失) ----------

export function startImport(fileList: FileList | File[], target: ImportTarget = 'viewport') {
  const files = [...fileList];
  if (files.length === 0) return;
  const q = ensureQueue();
  const valid: { file: File; format: ReturnType<typeof detectFormat> }[] = [];
  for (const f of files) {
    try {
      const format = detectFormat(f.name);
      if (f.size > MAX_FILE_BYTES) throw new ParseFailure('oversize');
      valid.push({ file: f, format });
    } catch (e) {
      const pf = e instanceof ParseFailure ? e : new ParseFailure('internal');
      q.enqueueFailed(f.name, { code: pf.code, message: pf.message || FAILURE_COPY[pf.code], retryable: false });
    }
  }
  valid.forEach(({ file, format }, i) => {
    const job = q.enqueue(file.name, file, format, i, valid.length);
    jobTarget.set(job.id, target);
  });
}

export function cancelImport(jobId: string) {
  ensureQueue().cancel(jobId);
}
export function retryImport(jobId: string) {
  ensureQueue().retry(jobId);
}
export function dismissImport(jobId: string) {
  ensureQueue().remove(jobId);
  useUi.getState().dropImportJob(jobId);
}

// ---------- 解析完成 → 单位裁决 ----------

function onParsed(job: ImportJob, ok: OkReply) {
  const positions = new Float32Array(ok.positions);
  const normals = ok.normals ? new Float32Array(ok.normals) : null;
  const slotX = slotXOf(job.slot, job.batchSize);
  const baseName = job.name.replace(/\.[^.]+$/, '');
  const target = jobTarget.get(job.id) ?? 'viewport';

  if (ok.meta.gltfBaked) {
    // glTF:米→毫米已烘焙,按规范直换不询问(IMP-05);unitChoice 记录源单位 m
    finalize(job.id, baseName, positions, normals, ok.meta, 'm', 1, slotX, target);
    return;
  }

  const maxEdge = Math.max(
    ok.meta.bboxRaw.max[0] - ok.meta.bboxRaw.min[0],
    ok.meta.bboxRaw.max[1] - ok.meta.bboxRaw.min[1],
    ok.meta.bboxRaw.max[2] - ok.meta.bboxRaw.min[2],
  );
  const decision = inferUnit(maxEdge);

  if (decision.kind === 'silent-mm') {
    const assetId = finalize(job.id, baseName, positions, normals, ok.meta, 'mm', 1, slotX, target);
    // 可撤 toast:原始顶点留一个重选窗口
    rawStore.set(job.id, { name: baseName, positions: positions.slice(), normals, meta: ok.meta, slotX, target });
    setTimeout(() => rawStore.delete(job.id), RAW_RETENTION_MS);
    useUi
      .getState()
      .setToast(`已按毫米${target === 'library' ? '入库' : '导入'}「${baseName}」`, {
        label: '重选单位',
        run: () => redecideUnit(job.id, assetId),
      });
    return;
  }

  // 弹确认:进入幽灵预览,未入库未入栈(仅入库同样借床上幽灵体做尺寸判断)
  rawStore.set(job.id, { name: baseName, positions, normals, meta: ok.meta, slotX, target });
  askWaitline.push(job.id);
  pumpAsk(decision.recommended);
}

function pumpAsk(recommended?: UnitChoice) {
  if (useUi.getState().unitAsk) return; // 对话框占用中
  const jobId = askWaitline.shift();
  if (!jobId) return;
  const raw = rawStore.get(jobId);
  if (!raw) return pumpAsk();
  const rec =
    recommended ??
    (() => {
      const d = inferUnit(
        Math.max(
          raw.meta.bboxRaw.max[0] - raw.meta.bboxRaw.min[0],
          raw.meta.bboxRaw.max[1] - raw.meta.bboxRaw.min[1],
          raw.meta.bboxRaw.max[2] - raw.meta.bboxRaw.min[2],
        ),
      );
      return d.kind === 'ask' ? d.recommended : 'mm';
    })();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(raw.positions, 3));
  if (raw.normals) geo.setAttribute('normal', new THREE.BufferAttribute(raw.normals, 3));
  else geo.computeVertexNormals();
  ghostStore.geo = geo;
  const ask: UnitAskState = {
    jobId,
    name: raw.name,
    bboxRaw: raw.meta.bboxRaw,
    unit: rec,
    recommended: rec,
    slotX: raw.slotX,
  };
  useUi.getState().setUnitAsk(ask);
}

/** 对话框「确认导入」:此刻才发生入库与入栈 */
export function confirmUnitAsk(unit: UnitChoice) {
  const ask = useUi.getState().unitAsk;
  if (!ask) return;
  const raw = rawStore.get(ask.jobId);
  closeAsk(ask.jobId);
  if (!raw) return;
  finalize(ask.jobId, raw.name, raw.positions, raw.normals, raw.meta, unit, UNIT_FACTOR[unit], raw.slotX, raw.target);
}

/** 对话框「取消导入」:幽灵退场,历史栈与资产库全程零写入 */
export function cancelUnitAsk() {
  const ask = useUi.getState().unitAsk;
  if (!ask) return;
  closeAsk(ask.jobId);
  const view = useUi.getState().importJobs.find((j) => j.id === ask.jobId);
  if (view)
    useUi.getState().upsertImportJob({ ...view, phase: 'canceled', phaseText: '已取消(未选单位)', pct: 0 });
  setTimeout(() => {
    useUi.getState().dropImportJob(ask.jobId);
    queue?.remove(ask.jobId);
  }, 2500);
}

function closeAsk(jobId: string) {
  rawStore.delete(jobId);
  ghostStore.geo?.dispose();
  ghostStore.geo = null;
  useUi.getState().setUnitAsk(null);
  // 让出一拍再放行下一件,避免同帧关-开对话框
  setTimeout(() => pumpAsk(), 0);
}

/** 静默 mm 的「重选单位」:级联删除刚导入的资产(可撤销的一步),用保留顶点重开确认流 */
function redecideUnit(jobId: string, assetId: string) {
  const raw = rawStore.get(jobId);
  if (!raw) {
    useUi.getState().setToast('重选窗口已过期,可撤销后重新导入');
    return;
  }
  if (doc.assets.has(assetId)) {
    // 注册表条目保留到会话结束:撤销这步「删除资产」时几何与缩略图须完整还原(T11 起持久层
    // 走对账同步,库内记录随文档状态自动增删,注册表残留仅占会话内存,不落库)
    dispatch((d) => d.removeAssetCascade(assetId));
  }
  askWaitline.push(jobId);
  pumpAsk();
}

// ---------- 入库 + 落场 ----------

export function finalize(
  jobId: string,
  name: string,
  positions: Float32Array,
  normals: Float32Array | null,
  meta: OkReply['meta'],
  unit: UnitChoice,
  factor: number,
  slotX: number,
  target: ImportTarget = 'viewport',
): string {
  if (factor !== 1) for (let i = 0; i < positions.length; i++) positions[i] *= factor;
  const bbox = {
    min: meta.bboxRaw.min.map((v) => v * factor) as [number, number, number],
    max: meta.bboxRaw.max.map((v) => v * factor) as [number, number, number],
  };

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normals) geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3)); // 均匀缩放不改法线方向
  else geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  // 入库经 dispatch:仅入库路径没有后续 placeInstance,需靠这次 bump 驱动资产面板刷新
  const asset = dispatch((d) =>
    d.addAsset({
      name,
      source: 'import',
      state: 'ready',
      meta: {
        faces: meta.faces,
        vertices: meta.vertices,
        bbox,
        unitChoice: unit,
        watertight: meta.watertight,
        degenerate: meta.degenerateCount > 0,
        materialMissing: meta.materialMissing || undefined,
        createdAt: Date.now(),
      },
    }),
  );
  geometryRegistry.set(asset.id, geo);
  const thumb = renderThumbnail(geo);
  if (thumb) thumbRegistry.set(asset.id, thumb);

  if (target === 'viewport') {
    // 床中心(批内错位)+ 自动沉底,一步入栈(IMP-02 / C1)
    dispatch((d) => d.placeInstance(asset.id, '导入', 'place', [slotX, 0, -bbox.min[2]]));
  }
  // 仅入库:不建实例、不入历史栈(资产库操作不入栈);对账同步器随 bump 落库

  // 完成条目补缩略图
  const view = useUi.getState().importJobs.find((j) => j.id === jobId);
  if (view) useUi.getState().upsertImportJob({ ...view, thumb });

  // 提示合流:面数超限警告(IMP-03,不拒绝)、缺材质降级(IMP-07)与仅入库反馈拼单条 toast
  const notes: string[] = [];
  if (target === 'library') notes.push('已入库,可从资产面板拖入视口放置');
  if (meta.faces > FACE_WARN_LIMIT)
    notes.push(`面数 ${(meta.faces / 10000).toFixed(0)} 万超过建议上限,编辑可能变慢`);
  if (meta.materialMissing) notes.push('OBJ 缺 MTL,已用默认材质');
  if (notes.length) useUi.getState().setToast(`「${name}」${notes.join(';')}`);

  return asset.id;
}

/** 资产面板拖入视口 / 双击放置(AST-03):床中心 + 自动沉底,一步入栈,与导入落场同语义 */
export function placeFromLibrary(assetId: string): boolean {
  const asset = doc.assets.get(assetId);
  if (!asset || asset.state !== 'ready' || !geometryRegistry.has(assetId)) return false;
  const z = -asset.meta.bbox.min[2];
  dispatch((d) => d.placeInstance(assetId, '放置', 'place', [0, 0, z]));
  return true;
}
