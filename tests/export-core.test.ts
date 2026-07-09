// T15 导出核心单测 —— STL 二进制字节层与 zip 结构层的直接验证。
// STL 断言到字节:头部嗅探安全、三角计数、世界坐标、facet normal、镜像绕序修正(负行列式)。
// zip 以手写解析器回读:签名/条目数/CRC/UTF-8 标志/偏移自洽 —— 写出器与解析器独立实现,互为对拍。

import { describe, expect, it } from 'vitest';
import {
  crc32,
  dedupeNames,
  det3,
  fmtSize,
  partTriangleCount,
  sanitizeName,
  writeBinarySTL,
  zipStore,
  STL_HEADER,
  type ExportPart,
} from '../src/export/export-core';
import { composeTRS } from '../src/check/check-core';
import type { Transform } from '../src/kernel/types';

const T = (over: Partial<Transform> = {}): Transform => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  ...over,
});

/** XY 平面上一枚 CCW 三角(俯视逆时针 → 外向法线 +Z) */
const triXY = (): ExportPart => ({
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
  index: null,
  transform: T(),
});

/** 索引几何:同一枚三角 × 2(共享顶点) */
const triIndexed = (): ExportPart => ({
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0]),
  index: new Uint32Array([0, 1, 2, 1, 3, 2]),
  transform: T(),
});

function readTri(buf: ArrayBuffer, i: number) {
  const dv = new DataView(buf);
  const off = 84 + i * 50;
  const f = (k: number) => dv.getFloat32(off + k * 4, true);
  return {
    normal: [f(0), f(1), f(2)],
    v: [
      [f(3), f(4), f(5)],
      [f(6), f(7), f(8)],
      [f(9), f(10), f(11)],
    ],
    attr: dv.getUint16(off + 48, true),
  };
}

describe('二进制 STL 写出(CHK-07/C3)', () => {
  it('空导出集:84 字节壳,计数 0', () => {
    const buf = writeBinarySTL([]);
    expect(buf.byteLength).toBe(84);
    expect(new DataView(buf).getUint32(80, true)).toBe(0);
  });

  it('头部不以 "solid" 开头(二进制/ASCII 嗅探兼容),且含单位声明', () => {
    const buf = writeBinarySTL([triXY()]);
    const head = new TextDecoder().decode(new Uint8Array(buf, 0, 80)).replace(/\0+$/, '');
    expect(head.startsWith('solid')).toBe(false);
    expect(head).toBe(STL_HEADER);
    expect(STL_HEADER).toContain('mm');
  });

  it('单三角:长度 84+50、计数 1、顶点原样直写(零转换)、attr=0、法线 +Z', () => {
    const buf = writeBinarySTL([triXY()]);
    expect(buf.byteLength).toBe(84 + 50);
    expect(new DataView(buf).getUint32(80, true)).toBe(1);
    const t = readTri(buf, 0);
    expect(t.v[0]).toEqual([0, 0, 0]);
    expect(t.v[1]).toEqual([10, 0, 0]);
    expect(t.v[2]).toEqual([0, 10, 0]);
    expect(t.attr).toBe(0);
    expect(t.normal[2]).toBeCloseTo(1, 6);
  });

  it('索引几何按索引展开:2 三角', () => {
    const buf = writeBinarySTL([triIndexed()]);
    expect(new DataView(buf).getUint32(80, true)).toBe(2);
    expect(partTriangleCount(triIndexed())).toBe(2);
  });

  it('平移写入世界坐标(检查器同口径:composeTRS)', () => {
    const p = { ...triXY(), transform: T({ position: [5, -3, 7] }) };
    const t = readTri(writeBinarySTL([p]), 0);
    expect(t.v[0]).toEqual([5, -3, 7]);
    expect(t.v[1]).toEqual([15, -3, 7]);
  });

  it('绕 Z 旋转 90°:(10,0,0) → (0,10,0)', () => {
    const p = { ...triXY(), transform: T({ rotation: [0, 0, 90] }) };
    const t = readTri(writeBinarySTL([p]), 0);
    expect(t.v[1][0]).toBeCloseTo(0, 4);
    expect(t.v[1][1]).toBeCloseTo(10, 4);
  });

  it('缩放生效', () => {
    const p = { ...triXY(), transform: T({ scale: [2, 3, 1] }) };
    const t = readTri(writeBinarySTL([p]), 0);
    expect(t.v[1][0]).toBeCloseTo(20, 4);
    expect(t.v[2][1]).toBeCloseTo(30, 4);
  });

  it('镜像(负缩放):行列式为负 → 绕序交换,外向法线保持 +Z 不内翻', () => {
    const mirrored = T({ scale: [-1, 1, 1] });
    expect(det3(composeTRS(mirrored))).toBeLessThan(0);
    const t = readTri(writeBinarySTL([{ ...triXY(), transform: mirrored }]), 0);
    expect(t.normal[2]).toBeCloseTo(1, 5); // 不修正绕序则为 −1(内外反转)
    expect(Math.min(...t.v.map((v) => v[0]))).toBeCloseTo(-10, 4); // 顶点确被镜像
  });

  it('合并导出:多件三角数求和,逐件应用各自变换', () => {
    const a = triXY();
    const b = { ...triIndexed(), transform: T({ position: [100, 0, 0] }) };
    const buf = writeBinarySTL([a, b]);
    expect(new DataView(buf).getUint32(80, true)).toBe(3);
    expect(readTri(buf, 1).v[0][0]).toBeCloseTo(100, 4);
  });

  it('退化三角:法线写零,不产 NaN', () => {
    const degen: ExportPart = {
      positions: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      index: null,
      transform: T(),
    };
    const t = readTri(writeBinarySTL([degen]), 0);
    expect(t.normal).toEqual([0, 0, 0]);
  });
});

describe('crc32 与 STORE zip', () => {
  it('crc32 标准测试向量:"123456789" → 0xCBF43926;空串 → 0', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('单条目 zip:局部头签名/STORE 法/UTF-8 标志/CRC/尺寸/数据原样', () => {
    const data = new TextEncoder().encode('hello stl');
    const buf = zipStore([{ name: '立方体.stl', data }]);
    const dv = new DataView(buf);
    expect(dv.getUint32(0, true)).toBe(0x04034b50); // local header sig
    expect(dv.getUint16(6, true) & 0x0800).toBe(0x0800); // UTF-8 flag
    expect(dv.getUint16(8, true)).toBe(0); // method STORE
    expect(dv.getUint32(14, true)).toBe(crc32(data));
    expect(dv.getUint32(18, true)).toBe(data.length);
    expect(dv.getUint32(22, true)).toBe(data.length);
    const nameLen = dv.getUint16(26, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, 30, nameLen));
    expect(name).toBe('立方体.stl');
    const body = new Uint8Array(buf, 30 + nameLen, data.length);
    expect(new TextDecoder().decode(body)).toBe('hello stl');
  });

  it('多条目 zip:EOCD 条目数/中央目录自洽,各条目偏移可回读到局部头', () => {
    const files = [
      { name: 'a.stl', data: new Uint8Array([1, 2, 3]) },
      { name: 'b.stl', data: new Uint8Array([4, 5, 6, 7]) },
    ];
    const buf = zipStore(files);
    const dv = new DataView(buf);
    const eocd = buf.byteLength - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2); // total entries
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdStart = dv.getUint32(eocd + 16, true);
    expect(cdStart + cdSize).toBe(eocd); // 目录紧邻 EOCD
    // 遍历中央目录,逐条目跳回局部头验证签名
    let off = cdStart;
    for (let i = 0; i < 2; i++) {
      expect(dv.getUint32(off, true)).toBe(0x02014b50);
      const nameLen = dv.getUint16(off + 28, true);
      const localOff = dv.getUint32(off + 42, true);
      expect(dv.getUint32(localOff, true)).toBe(0x04034b50);
      expect(dv.getUint32(off + 16, true)).toBe(crc32(files[i].data));
      off += 46 + nameLen;
    }
  });

  it('固定时间戳:同输入两次写出字节完全一致(确定性)', () => {
    const files = [{ name: 'x.stl', data: new Uint8Array([9, 9]) }];
    const a = new Uint8Array(zipStore(files));
    const b = new Uint8Array(zipStore(files));
    expect(a).toEqual(b);
  });
});

describe('文件名', () => {
  it('sanitize:非法字符置换、首尾点空格剥除', () => {
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeName('  .名字. ')).toBe('名字');
    expect(sanitizeName('...')).toBe('');
  });

  it('dedupe:重名追加 -2/-3(与内核实例命名同策略)', () => {
    expect(dedupeNames(['盒', '盒', '盒', '球'])).toEqual(['盒', '盒-2', '盒-3', '球']);
  });

  it('fmtSize 三档', () => {
    expect(fmtSize(500)).toBe('500 B');
    expect(fmtSize(2048)).toBe('2.0 KB');
    expect(fmtSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
