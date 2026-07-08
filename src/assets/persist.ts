// 资产库持久化(T11,C5 第二层 / AST-04)。
//
// 架构裁决:采用「对账同步器」而非命令内嵌写库 —— 订阅文档版本号,每次 command(含撤销/重做)
// 后把 doc.assets 与 IndexedDB 做差异对账:新增/改名 → 补写;消失 → 删除。好处:
//   1) 撤销「删除资产」后资产自动回到库里(几何/缩略图注册表在会话内不清空,见 ingest 注释),
//      历史栈(运行内存层)与持久层各管各的,天然一致;
//   2) 超限拒写的资产(AST-04)留在「未保存」集合,任何一次清理腾出空间后同一条对账路径自动补存,
//      无需专门的重试按钮;禁止自动 LRU 淘汰由「只拒写、不删旧」保证。
//
// 存储结构:'assets' 表存条目 JSON + 缩略图 dataURL;'geometry' 表存顶点/法线 ArrayBuffer
// (几何不可变:每资产至多写一次)。演示夹具(ast_demo_*)每次启动重建,不落库。
//
// 边界(PRD AST):
//   1. IndexedDB 不可用 → 纯内存会话模式,面板常驻提示「本次会话的资产不会被保存」;
//   3. 几何记录丢失/损坏 → 条目转「失效」,元数据与缩略图保留可查(导入源资产无云端副本,
//      不可恢复;AI 资产的云端回源属 AST-05,随 T16 生成链路接线)。

import { openDB, type IDBPDatabase } from 'idb';
import * as THREE from 'three';
import type { Asset } from '../kernel/types';
import { doc, geometryRegistry, thumbRegistry, useUi } from '../state/store';

export const STORAGE_CAP_BYTES = 500 * 1024 * 1024; // AST-04 / PRD §9
export const STORAGE_WARN_RATIO = 0.8;

export const isDemoAsset = (id: string) => id.startsWith('ast_demo_');

interface AssetRecord {
  asset: Asset;
  thumb: string | null;
}
interface GeoRecord {
  positions: ArrayBuffer;
  normals: ArrayBuffer | null;
}
interface Ledger {
  sig: string; // 条目部分的序列化指纹(改名等元数据变化触发补写)
  recBytes: number;
  geoBytes: number;
}

// ---------- 模块态 ----------

let db: IDBPDatabase | null = null;
let mode: 'init' | 'idb' | 'session' = 'init';
let capBytes = STORAGE_CAP_BYTES;
let usedBytes = 0;
const ledger = new Map<string, Ledger>(); // 已持久化 id → 账目
const unsaved = new Set<string>(); // 超限拒写、仅存活于本会话的资产
let warned80 = false;
let unsubscribe: (() => void) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncing: Promise<void> | null = null;
let dirty = false;

const sigOf = (asset: Asset, thumb: string | null) => JSON.stringify({ asset, thumb });
const recBytesOf = (sig: string) => sig.length * 2; // UTF-16 估算
const geoBytesOf = (g: GeoRecord) => g.positions.byteLength + (g.normals?.byteLength ?? 0);

function publish() {
  useUi.getState().setStorage({ mode, usedBytes, capBytes, unsavedIds: [...unsaved] });
}

/** 从注册表几何取出可入库的 ArrayBuffer(属性数组若为共享 buffer 的切片则复制) */
function extractGeo(assetId: string): GeoRecord | null {
  const geo = geometryRegistry.get(assetId);
  const pos = geo?.getAttribute('position');
  if (!geo || !pos) return null;
  const toBuf = (arr: THREE.TypedArray): ArrayBuffer => {
    const t = arr as Float32Array;
    return t.byteOffset === 0 && t.byteLength === t.buffer.byteLength
      ? (t.buffer as ArrayBuffer)
      : (t.slice().buffer as ArrayBuffer);
  };
  const nrm = geo.getAttribute('normal');
  return { positions: toBuf(pos.array), normals: nrm ? toBuf(nrm.array) : null };
}

function buildGeometry(rec: GeoRecord): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rec.positions), 3));
  if (rec.normals) geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(rec.normals), 3));
  else geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// ---------- 初始化(App 挂载后调用一次;失败即降级会话模式,不阻断使用) ----------

export interface PersistOptions {
  dbName?: string; // 测试注入
  cap?: number; // 测试注入
}

export async function initPersistence(opts: PersistOptions = {}): Promise<void> {
  capBytes = opts.cap ?? STORAGE_CAP_BYTES;
  if (typeof indexedDB === 'undefined') {
    mode = 'session';
    publish();
    return;
  }
  try {
    db = await openDB(opts.dbName ?? '3d-std', 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets');
        if (!d.objectStoreNames.contains('geometry')) d.createObjectStore('geometry');
      },
    });
    await loadAll();
    mode = 'idb';
  } catch {
    db = null;
    mode = 'session'; // 隐私模式 / 配额拒绝等:全站降级,常驻提示(AST 边界 1)
  }
  publish();
  if (mode === 'idb') {
    unsubscribe = useUi.subscribe((s, prev) => {
      if (s.rev !== prev.rev) scheduleSync();
    });
    scheduleSync(); // 初始化前若已有导入,补一次对账
  }
  useUi.getState().bump(); // 装载结果驱动资产面板首帧
}

async function loadAll() {
  if (!db) return;
  const keys = (await db.getAllKeys('assets')) as string[];
  const toHydrate: Asset[] = [];
  for (const id of keys) {
    const rec = (await db.get('assets', id)) as AssetRecord | undefined;
    if (!rec?.asset) continue;
    const geoRec = (await db.get('geometry', id)) as GeoRecord | undefined;
    const asset: Asset = structuredClone(rec.asset);
    let geoBytes = 0;
    if (geoRec?.positions?.byteLength) {
      geometryRegistry.set(id, buildGeometry(geoRec));
      geoBytes = geoBytesOf(geoRec);
      if (asset.state === 'expired') asset.state = 'ready'; // 几何失而复得(理论路径)即复活
    } else {
      asset.state = 'expired'; // 边界 3:几何丢失 → 失效;元数据/缩略图保留可查
    }
    if (rec.thumb) thumbRegistry.set(id, rec.thumb);
    const sig = sigOf(asset, rec.thumb ?? null);
    ledger.set(id, { sig, recBytes: recBytesOf(sig), geoBytes });
    usedBytes += recBytesOf(sig) + geoBytes;
    toHydrate.push(asset);
  }
  doc.hydrateAssets(toHydrate); // 保留原 id + 抬高 genId 地板,防新旧 id 撞车
}

// ---------- 对账同步 ----------

function scheduleSync() {
  if (mode !== 'idb') return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void runSync(), 250);
}

function runSync(): Promise<void> {
  if (syncing) {
    dirty = true;
    return syncing;
  }
  syncing = reconcile()
    .catch(() => undefined)
    .finally(() => {
      syncing = null;
      if (dirty) {
        dirty = false;
        scheduleSync();
      }
    });
  return syncing;
}

async function reconcile() {
  if (!db || mode !== 'idb') return;
  const live = new Map<string, Asset>();
  for (const a of doc.assets.values()) if (!isDemoAsset(a.id)) live.set(a.id, a);

  // 1) 删除:库里有、文档里没了(删除资产 / 重选单位的级联删除)
  for (const [id, entry] of [...ledger]) {
    if (live.has(id)) continue;
    await db.delete('assets', id);
    await db.delete('geometry', id);
    usedBytes -= entry.recBytes + entry.geoBytes;
    ledger.delete(id);
  }

  // 2) 补写:新资产 / 改名 / 缩略图补齐;几何每 id 至多写一次(不可变)
  const newlyRefused: string[] = [];
  for (const [id, asset] of live) {
    if (asset.state !== 'ready' && asset.state !== 'expired') continue;
    const thumb = thumbRegistry.get(id) ?? null;
    const sig = sigOf(asset, thumb);
    const entry = ledger.get(id);
    if (entry && entry.sig === sig) {
      unsaved.delete(id);
      continue;
    }
    let geoRec: GeoRecord | null = null;
    let geoBytes = entry?.geoBytes ?? 0;
    if (!entry && asset.state === 'ready') {
      geoRec = extractGeo(id);
      if (!geoRec) continue; // 几何尚未注册(不应发生),下轮再试
      geoBytes = geoBytesOf(geoRec);
    }
    const recBytes = recBytesOf(sig);
    const projected = usedBytes - (entry ? entry.recBytes + entry.geoBytes : 0) + recBytes + geoBytes;
    if (projected > capBytes) {
      // AST-04:超限拒写(不淘汰旧资产)。资产仍可用于本会话;清理腾空后此处自动补存
      if (!unsaved.has(id)) {
        unsaved.add(id);
        newlyRefused.push(asset.name);
      }
      continue;
    }
    await db.put('assets', { asset: structuredClone(asset), thumb } satisfies AssetRecord, id);
    if (geoRec) await db.put('geometry', geoRec, id);
    usedBytes = projected;
    ledger.set(id, { sig, recBytes, geoBytes });
    unsaved.delete(id);
  }

  // 3) 提示:80% 一次性预警;拒写即时告知(AST-04)
  if (!warned80 && usedBytes >= capBytes * STORAGE_WARN_RATIO) {
    warned80 = true;
    useUi
      .getState()
      .setToast(`本地资产库已使用超过 80%(${fmtBytes(usedBytes)} / ${fmtBytes(capBytes)}),建议清理不再需要的资产`);
  }
  if (newlyRefused.length) {
    useUi
      .getState()
      .setToast(
        `本地存储空间不足,「${newlyRefused[0]}」${newlyRefused.length > 1 ? `等 ${newlyRefused.length} 项` : ''}仅保留在本次会话——在资产面板清理后将自动补存`,
      );
  }
  publish();
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

// ---------- 测试钩子 ----------

/** 立即执行一轮对账并等待完成(生产路径走 250ms 防抖) */
export async function _syncNowForTest(): Promise<void> {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  await runSync();
}

/** 复位模块态(模拟刷新;不清库,重新 init 即重放装载) */
export function _resetForTest() {
  unsubscribe?.();
  unsubscribe = null;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  db?.close();
  db = null;
  mode = 'init';
  usedBytes = 0;
  capBytes = STORAGE_CAP_BYTES;
  ledger.clear();
  unsaved.clear();
  warned80 = false;
  syncing = null;
  dirty = false;
}
