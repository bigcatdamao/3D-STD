import { describe, expect, it } from 'vitest';
import { SceneDocument } from '../src/kernel/scene.js';
import type { Asset } from '../src/kernel/types.js';

const asset = (name: string): Omit<Asset, 'id'> => ({
  name,
  source: 'import',
  state: 'ready',
  meta: {
    faces: 12,
    bbox: { min: [-10, -10, -10], max: [10, 10, 10] },
    unitChoice: 'mm',
    watertight: true,
    degenerate: false,
  },
});

describe('M1.18 配对连接历史原子性', () => {
  it('确认时两侧一起切换派生资产，撤销与重做始终保持配对', () => {
    const scene = new SceneDocument();
    const a = scene.addAsset(asset('A'));
    const b = scene.addAsset(asset('B'));
    const ia = scene.placeInstance(a.id);
    const ib = scene.placeInstance(b.id);
    const beforeHistory = scene.history.length;
    const derived = scene.replaceInstanceAssetsWithDerivedPair(
      [ia.id, ib.id],
      [asset('A · 凸榫'), asset('B · 凹槽')],
      '添加圆柱连接',
    );
    expect(scene.history.length).toBe(beforeHistory + 1);
    expect(scene.history.list().at(-1)?.op).toBe('connector');
    expect(scene.instance(ia.id).assetId).toBe(derived[0].id);
    expect(scene.instance(ib.id).assetId).toBe(derived[1].id);

    scene.history.undo();
    expect(scene.instance(ia.id).assetId).toBe(a.id);
    expect(scene.instance(ib.id).assetId).toBe(b.id);
    expect(scene.assets.has(derived[0].id)).toBe(false);
    expect(scene.assets.has(derived[1].id)).toBe(false);

    scene.history.redo();
    expect(scene.instance(ia.id).assetId).toBe(derived[0].id);
    expect(scene.instance(ib.id).assetId).toBe(derived[1].id);
  });
});
