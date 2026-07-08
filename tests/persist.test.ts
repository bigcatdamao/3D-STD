// T11 持久化测试(fake-indexeddb 提供 Node 侧 IndexedDB)。
// 覆盖:往返装载(刷新模拟)、genId 地板防撞车、改名/删除对账、AST-04 容量策略
// (80% 预警 / 超限拒写 / 清理后自动补存 / 不淘汰旧资产)、几何丢失 → 失效(边界 3)、
// IndexedDB 不可用 → 会话模式(边界 1)、演示夹具不落库。

import 'fake-indexeddb/auto';
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetForTest,
  _syncNowForTest,
  fmtBytes,
  initPersistence,
  isDemoAsset,
} from '../src/assets/persist';
import type { Asset } from '../src/kernel/types';
import { dispatch, doc, geometryRegistry, thumbRegistry, useUi } from '../src/state/store';

let dbSeq = 0;
const freshDbName = () => `t11-test-${++dbSeq}`;

/** 造一个 ready 资产并注册几何(近似 finalize 的产物);vertexCount 控制字节量 */
function makeAsset(name: string, vertexCount = 24): Asset {
  const asset = dispatch((d) =>
    d.addAsset({
      name,
      source: 'import',
      state: 'ready',
      meta: {
        faces: vertexCount / 3,
        bbox: { min: [0, 0, 0], max: [10, 10, 10] },
        unitChoice: 'mm',
        watertight: true,
        degenerate: false,
        createdAt: Date.now(),
      },
    }),
  );
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
  geometryRegistry.set(asset.id, geo);
  return asset;
}

/** 模拟刷新:清空文档资产与注册表(演示夹具除外的一切会话态),复位持久层模块 */
function simulateReload() {
  _resetForTest();
  for (const id of [...doc.assets.keys()]) {
    doc.assets.delete(id);
    geometryRegistry.delete(id);
    thumbRegistry.delete(id);
  }
  for (const id of [...doc.nodes.keys()]) doc.nodes.delete(id);
  for (const k of [...doc.order.keys()]) doc.order.set(k, []);
  doc.selection.clear();
}

afterEach(() => {
  simulateReload();
  useUi.setState({ toast: null });
});

describe('往返装载(C5 / AST-04)', () => {
  it('资产 + 几何 + 缩略图跨"刷新"存活,id 与元数据不变', async () => {
    await initPersistence({ dbName: 'roundtrip' });
    const a = makeAsset('支架');
    thumbRegistry.set(a.id, 'data:image/png;base64,xx');
    await _syncNowForTest();

    simulateReload();
    await initPersistence({ dbName: 'roundtrip' });

    const back = doc.assets.get(a.id);
    expect(back?.name).toBe('支架');
    expect(back?.state).toBe('ready');
    expect(back?.meta.faces).toBe(8);
    expect(geometryRegistry.get(a.id)?.getAttribute('position')?.count).toBe(24);
    expect(thumbRegistry.get(a.id)).toContain('base64');
  });

  it('装载抬高 genId 地板:刷新后新资产 id 不与旧资产撞车', async () => {
    const db = freshDbName();
    await initPersistence({ dbName: db });
    const a = makeAsset('旧件');
    await _syncNowForTest();

    simulateReload();
    await initPersistence({ dbName: db });
    const b = makeAsset('新件');
    expect(b.id).not.toBe(a.id);
    expect(doc.assets.size).toBe(2);
  });

  it('改名经对账补写持久(库操作不入历史栈)', async () => {
    const db = freshDbName();
    await initPersistence({ dbName: db });
    const a = makeAsset('原名');
    await _syncNowForTest();
    const depth = doc.history.length;
    dispatch((d) => d.renameAsset(a.id, '新名'));
    expect(doc.history.length).toBe(depth); // 不入栈
    await _syncNowForTest();

    simulateReload();
    await initPersistence({ dbName: db });
    expect(doc.assets.get(a.id)?.name).toBe('新名');
  });

  it('删除资产 → 库内记录移除且容量回收;撤销后对账自动补回', async () => {
    const db = freshDbName();
    await initPersistence({ dbName: db });
    const a = makeAsset('将删');
    await _syncNowForTest();
    const usedBefore = useUi.getState().storage.usedBytes;
    expect(usedBefore).toBeGreaterThan(0);

    dispatch((d) => d.removeAssetCascade(a.id));
    await _syncNowForTest();
    expect(useUi.getState().storage.usedBytes).toBe(0);

    dispatch((d) => d.history.undo()); // 撤销删除:资产回文档,注册表未清 → 同步器补写
    await _syncNowForTest();
    expect(doc.assets.has(a.id)).toBe(true);
    expect(useUi.getState().storage.usedBytes).toBe(usedBefore);

    simulateReload();
    await initPersistence({ dbName: db });
    expect(doc.assets.get(a.id)?.name).toBe('将删'); // 撤销的结果同样被持久化
  });

  it('演示夹具(ast_demo_*)不落库', async () => {
    const db = freshDbName();
    await initPersistence({ dbName: db });
    doc.hydrateAssets([
      {
        id: 'ast_demo_x',
        name: '演示',
        source: 'import',
        state: 'ready',
        meta: { faces: 1, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, unitChoice: 'mm', watertight: true, degenerate: false },
      },
    ]);
    useUi.getState().bump();
    await _syncNowForTest();
    expect(useUi.getState().storage.usedBytes).toBe(0);
    expect(isDemoAsset('ast_demo_x')).toBe(true);
  });
});

describe('容量策略(AST-04)', () => {
  it('超限拒写:条目入未保存集、库不写入;清理腾空后自动补存;旧资产不被淘汰', async () => {
    const db = freshDbName();
    // 定容:够存"小件",不够同时存"大件"(大件单独可存)
    await initPersistence({ dbName: db, cap: 6000 });
    const small = makeAsset('小件', 24); // 几何 288B + 记录
    await _syncNowForTest();
    expect(useUi.getState().storage.unsavedIds).toEqual([]);

    const big = makeAsset('大件', 400); // 几何 4800B:与小件同存必超 6000
    await _syncNowForTest();
    const st = useUi.getState().storage;
    expect(st.unsavedIds).toEqual([big.id]); // 拒写大件
    expect(useUi.getState().toast?.text).toContain('仅保留在本次会话'); // 拒写即时告知
    expect(doc.assets.has(small.id)).toBe(true); // 禁止自动 LRU:旧资产安然无恙

    dispatch((d) => d.removeAssetCascade(small.id)); // 用户清理
    await _syncNowForTest();
    expect(useUi.getState().storage.unsavedIds).toEqual([]); // 大件自动补存

    simulateReload();
    await initPersistence({ dbName: db, cap: 6000 });
    expect(doc.assets.has(big.id)).toBe(true);
    expect(doc.assets.has(small.id)).toBe(false);
  });

  it('用量越过 80% 触发一次性预警 toast', async () => {
    const db = freshDbName();
    await initPersistence({ dbName: db, cap: 4000 });
    makeAsset('占位', 260); // 3120B 几何 > 4000×0.8
    await _syncNowForTest();
    expect(useUi.getState().toast?.text).toContain('80%');
  });

  it('fmtBytes 三档', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2 KB');
    expect(fmtBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
  });
});

describe('降级路径(AST 边界 1/3)', () => {
  it('几何记录丢失 → 条目转失效,元数据与缩略图保留可查', async () => {
    const db = freshDbName();
    await initPersistence({ dbName: db });
    const a = makeAsset('会失效');
    thumbRegistry.set(a.id, 'data:thumb');
    await _syncNowForTest();

    // 模拟本地损坏:直接从库里抠掉几何记录
    const { openDB } = await import('idb');
    simulateReload();
    const raw = await openDB(db, 1);
    await raw.delete('geometry', a.id);
    raw.close();

    await initPersistence({ dbName: db });
    const back = doc.assets.get(a.id);
    expect(back?.state).toBe('expired');
    expect(back?.meta.faces).toBe(8); // 元数据永久保留
    expect(thumbRegistry.get(a.id)).toBe('data:thumb');
    expect(geometryRegistry.has(a.id)).toBe(false);
  });

  it('IndexedDB 不可用 → 会话模式,导入照常、不抛错', async () => {
    const saved = (globalThis as Record<string, unknown>).indexedDB;
    delete (globalThis as Record<string, unknown>).indexedDB;
    try {
      await initPersistence();
      expect(useUi.getState().storage.mode).toBe('session');
      const a = makeAsset('会话件');
      await _syncNowForTest(); // 无库可写,静默通过
      expect(doc.assets.has(a.id)).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).indexedDB = saved;
    }
  });
});
