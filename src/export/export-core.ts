// STL 导出核心(T15)—— CHK-07 的纯逻辑层,零 DOM 依赖,单元测试直接覆盖。
//
// 关键裁决(技术方案 v1.7 ①,D5 落地修订):写出器不用 three 的 STLExporter,而是复用
// 检查器的 composeTRS(check-core)逐顶点直写 —— 检查报告度量的世界几何与导出文件字节
// 严格同口径(检查说「zMin=0」的对象,导出后在切片软件里就贴在 z=0)。附带解决两个
// STLExporter 不管的坑:① 负缩放(镜像)使三角形绕序翻转,需按矩阵行列式交换 v1/v2,
// 否则镜像件在切片软件中内外反转;② 二进制 STL 头部不得以 "solid" 开头(部分解析器
// 以此嗅探 ASCII 格式,误判后读崩)。
//
// zip 打包(逐对象导出)为手写 STORE 法(无压缩):PKZIP 结构 ~80 行,免引压缩库依赖;
// 条目名带 UTF-8 标志位(bit 11),中文对象名跨平台可读。固定时间戳保证字节确定性(可测)。

import { composeTRS } from '../check/check-core';
import type { Transform } from '../kernel/types';
import type * as THREE from 'three';

// ---------- 导出件 ----------

export interface ExportPart {
  positions: Float32Array; // 局部坐标,紧凑 xyz
  index: Uint32Array | null; // null = 非索引几何(顺序三顶点一面)
  transform: Transform; // 实例世界 TRS(组不携带变换,实例 transform 即世界变换)
}

export function partTriangleCount(p: ExportPart): number {
  return Math.floor((p.index ? p.index.length : p.positions.length / 3) / 3);
}

/** 渲染几何 → 紧凑数组。交错缓冲(GLB 可能出现)逐顶点抽取 —— 与 check-state.geometryOf 同思路 */
export function extractGeometry(
  g: THREE.BufferGeometry | undefined,
): { positions: Float32Array; index: Uint32Array | null } | null {
  const attr = g?.getAttribute('position');
  if (!g || !attr) return null;
  let positions: Float32Array;
  if (
    !('isInterleavedBufferAttribute' in attr && attr.isInterleavedBufferAttribute) &&
    attr.array instanceof Float32Array
  ) {
    positions = attr.array.slice(0, attr.count * 3);
  } else {
    positions = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++) {
      positions[i * 3] = attr.getX(i);
      positions[i * 3 + 1] = attr.getY(i);
      positions[i * 3 + 2] = attr.getZ(i);
    }
  }
  const index = g.index ? Uint32Array.from(g.index.array as ArrayLike<number>) : null;
  return { positions, index };
}

// ---------- 二进制 STL 写出 ----------

/** 80 字节头。注意:不得以 "solid" 开头(ASCII 格式嗅探误判),'3' 打头安全 */
export const STL_HEADER = '3D-STD binary STL · units: mm · Z-up · exported client-side';

/** 4×4 列主序矩阵的左上 3×3 行列式(负值 = 含镜像,绕序需翻转) */
export function det3(e: Float64Array): number {
  return (
    e[0] * (e[5] * e[10] - e[9] * e[6]) -
    e[4] * (e[1] * e[10] - e[9] * e[2]) +
    e[8] * (e[1] * e[6] - e[5] * e[2])
  );
}

/** 多导出件 → 单个二进制 STL(C3:世界即 Z-up mm,零坐标转换直写)。
 *  合并导出 = 全部件传入;逐对象 = 单件调用。facet normal 由世界顶点叉积重算
 *  (变换后局部法线失效);退化三角形法线写零(STL 规范允许,切片器自行重算)。 */
export function writeBinarySTL(parts: ExportPart[]): ArrayBuffer {
  let tris = 0;
  for (const p of parts) tris += partTriangleCount(p);
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const header = new TextEncoder().encode(STL_HEADER);
  new Uint8Array(buf, 0, 80).set(header.subarray(0, Math.min(80, header.length)));
  dv.setUint32(80, tris, true);

  let off = 84;
  const w = new Float64Array(9); // 当前三角形的三个世界顶点
  for (const p of parts) {
    const e = composeTRS(p.transform);
    const flip = det3(e) < 0; // 镜像:交换 v1/v2 维持外向绕序
    const n = partTriangleCount(p);
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 3; k++) {
        // 绕序修正在索引层完成:k=1/2 互换
        const kk = flip && k > 0 ? 3 - k : k;
        const vi = p.index ? p.index[t * 3 + kk] : t * 3 + kk;
        const x = p.positions[vi * 3];
        const y = p.positions[vi * 3 + 1];
        const z = p.positions[vi * 3 + 2];
        w[k * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
        w[k * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        w[k * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      // facet normal = normalize(cross(b−a, c−a))
      const ux = w[3] - w[0], uy = w[4] - w[1], uz = w[5] - w[2];
      const vx = w[6] - w[0], vy = w[7] - w[1], vz = w[8] - w[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-12) {
        nx /= len; ny /= len; nz /= len;
      } else {
        nx = 0; ny = 0; nz = 0; // 退化面:零法线,不产 NaN
      }
      dv.setFloat32(off, nx, true);
      dv.setFloat32(off + 4, ny, true);
      dv.setFloat32(off + 8, nz, true);
      for (let k = 0; k < 9; k++) dv.setFloat32(off + 12 + k * 4, w[k], true);
      dv.setUint16(off + 48, 0, true); // attribute byte count
      off += 50;
    }
  }
  return buf;
}

// ---------- 文件名 ----------

/** 跨平台非法字符置换 + 去首尾点空格;空名回退由调用方决定 */
export function sanitizeName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120);
}

/** 重名追加序号(与内核 dedupeName 同策略:name、name-2、name-3…) */
export function dedupeNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((n) => {
    let candidate = n;
    let i = 2;
    while (taken.has(candidate)) candidate = `${n}-${i++}`;
    taken.add(candidate);
    return candidate;
  });
}

// ---------- 手写 STORE zip(PKZIP,无压缩) ----------

let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 固定 DOS 时间戳(2026-01-01 00:00):导出字节确定,同输入同输出(可测、可对拍) */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
/** 通用标志 bit 11:条目名为 UTF-8(中文对象名跨平台可读) */
const FLAG_UTF8 = 0x0800;

export interface ZipEntryInput {
  name: string; // 含扩展名;编码 UTF-8
  data: Uint8Array;
}

/** STORE 法 zip:局部头 + 数据 … 中央目录 … EOCD。所有解压器可读(无压缩无加密) */
export function zipStore(files: ZipEntryInput[]): ArrayBuffer {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ name: enc.encode(f.name), data: f.data, crc: crc32(f.data) }));

  let localSize = 0;
  let centralSize = 0;
  for (const e of entries) {
    localSize += 30 + e.name.length + e.data.length;
    centralSize += 46 + e.name.length;
  }
  const buf = new ArrayBuffer(localSize + centralSize + 22);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  const offsets: number[] = [];
  let off = 0;
  for (const e of entries) {
    offsets.push(off);
    dv.setUint32(off, 0x04034b50, true); // local file header signature
    dv.setUint16(off + 4, 20, true); // version needed
    dv.setUint16(off + 6, FLAG_UTF8, true);
    dv.setUint16(off + 8, 0, true); // method: STORE
    dv.setUint16(off + 10, DOS_TIME, true);
    dv.setUint16(off + 12, DOS_DATE, true);
    dv.setUint32(off + 14, e.crc, true);
    dv.setUint32(off + 18, e.data.length, true); // compressed = uncompressed(STORE)
    dv.setUint32(off + 22, e.data.length, true);
    dv.setUint16(off + 26, e.name.length, true);
    dv.setUint16(off + 28, 0, true); // extra length
    u8.set(e.name, off + 30);
    u8.set(e.data, off + 30 + e.name.length);
    off += 30 + e.name.length + e.data.length;
  }

  const centralStart = off;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    dv.setUint32(off, 0x02014b50, true); // central directory signature
    dv.setUint16(off + 4, 20, true); // version made by
    dv.setUint16(off + 6, 20, true); // version needed
    dv.setUint16(off + 8, FLAG_UTF8, true);
    dv.setUint16(off + 10, 0, true); // method
    dv.setUint16(off + 12, DOS_TIME, true);
    dv.setUint16(off + 14, DOS_DATE, true);
    dv.setUint32(off + 16, e.crc, true);
    dv.setUint32(off + 20, e.data.length, true);
    dv.setUint32(off + 24, e.data.length, true);
    dv.setUint16(off + 28, e.name.length, true);
    // extra/comment/disk/internal attrs = 0
    dv.setUint32(off + 38, 0, true); // external attrs
    dv.setUint32(off + 42, offsets[i], true); // local header offset
    u8.set(e.name, off + 46);
    off += 46 + e.name.length;
  }

  dv.setUint32(off, 0x06054b50, true); // EOCD signature
  dv.setUint16(off + 8, entries.length, true); // entries on this disk
  dv.setUint16(off + 10, entries.length, true); // total entries
  dv.setUint32(off + 12, centralSize, true);
  dv.setUint32(off + 16, centralStart, true);
  return buf;
}

/** 人类可读文件尺寸(toast 用) */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
