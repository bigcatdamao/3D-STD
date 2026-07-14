// T11 资产面板纯逻辑测试:网格条目投影(解析中/失败来自队列,就绪/失效来自内核,
// done 不重复)、排序(时间倒序、演示垫底)、级联删除信息(AST-03)、确认口径(边界 5)。

import { describe, expect, it } from 'vitest';
import {
  buildTiles,
  cascadeInfo,
  filterAndSortTiles,
  needsDeleteConfirm,
  sizeTextOf,
  tileTooltip,
} from '../src/assets/asset-logic';
import { SceneDocument } from '../src/kernel/scene';
import type { Asset } from '../src/kernel/types';
import type { ImportJobView } from '../src/state/store';

const asset = (id: string, name: string, over: Partial<Asset> = {}, createdAt?: number): Asset => ({
  id,
  name,
  source: 'import',
  state: 'ready',
  meta: {
    faces: 100,
    bbox: { min: [0, 0, 0], max: [30, 20, 10] },
    unitChoice: 'mm',
    watertight: true,
    degenerate: false,
    createdAt,
  },
  ...over,
});

const job = (id: string, phase: ImportJobView['phase'], extra: Partial<ImportJobView> = {}): ImportJobView => ({
  id,
  name: `${id}.stl`,
  phase,
  pct: phase === 'running' ? 40 : 0,
  phaseText: phase === 'running' ? '解析几何' : '排队中',
  ...extra,
});

describe('buildTiles 状态机合流(AST-01/02)', () => {
  it('解析中在前(队列序),资产按入库时间倒序,演示夹具垫底;done/canceled 不进网格', () => {
    const tiles = buildTiles(
      [asset('ast_demo_box', '演示'), asset('ast_1', '早件', {}, 1000), asset('ast_2', '晚件', {}, 2000)],
      [job('imp_1', 'running'), job('imp_2', 'queued'), job('imp_3', 'done'), job('imp_4', 'canceled')],
      () => null,
      [],
    );
    expect(tiles.map((t) => t.id)).toEqual(['imp_1', 'imp_2', 'ast_2', 'ast_1', 'ast_demo_box']);
    expect(tiles[0].state).toBe('parsing');
    expect(tiles[0].pct).toBe(40);
    expect(tiles[4].demo).toBe(true);
  });

  it('失败任务成失败条目(带分类文案与可重试标记);失效资产成失效条目', () => {
    const tiles = buildTiles(
      [asset('ast_1', '失效件', { state: 'expired' })],
      [job('imp_1', 'failed', { error: { code: 'corrupt', message: '无法解析为有效的 GLB 文件', retryable: true } })],
      () => null,
      [],
    );
    expect(tiles[0]).toMatchObject({ state: 'failed', errorText: '无法解析为有效的 GLB 文件', retryable: true });
    expect(tiles[1].state).toBe('expired');
  });

  it('未保存集与缩略图注入条目;来源角标随资产来源', () => {
    const tiles = buildTiles(
      [asset('ast_1', 'AI 件', { source: 'ai' }, 1)],
      [],
      (id) => (id === 'ast_1' ? 'data:thumb' : null),
      ['ast_1'],
    );
    expect(tiles[0]).toMatchObject({ source: 'ai', thumb: 'data:thumb', unsaved: true });
  });
});

describe('级联删除(AST-03 / 边界 5)', () => {
  it('cascadeInfo 统计全场景(含组内)引用实例', () => {
    const d = new SceneDocument();
    d.hydrate([asset('ast_1', '件')], []);
    d.placeInstance('ast_1');
    d.placeInstance('ast_1');
    const ids = [...d.nodes.keys()];
    d.group(ids); // 入组后仍应统计到
    const info = cascadeInfo(d, 'ast_1');
    expect(info.count).toBe(2);
    expect(info.names[0]).toContain('件');
  });

  it('确认口径:就绪需级联确认,失败/失效/解析中直接移除', () => {
    expect(needsDeleteConfirm('ready')).toBe(true);
    expect(needsDeleteConfirm('failed')).toBe(false);
    expect(needsDeleteConfirm('expired')).toBe(false);
    expect(needsDeleteConfirm('parsing')).toBe(false);
  });
});

describe('条目摘要(AST-02 元数据)', () => {
  it('尺寸文案与 tooltip 关键字段', () => {
    const a = asset('ast_1', '样件', { meta: { faces: 12000, bbox: { min: [0, 0, 0], max: [123.4, 20, 10] }, unitChoice: 'cm', watertight: null, degenerate: false, materialMissing: true, createdAt: 1720000000000 } });
    expect(sizeTextOf(a.meta)).toBe('123 × 20.0 × 10.0 mm');
    const tip = tileTooltip(buildTiles([a], [], () => null, [])[0]);
    expect(tip).toContain('12,000 面');
    expect(tip).toContain('单位:cm');
    expect(tip).toContain('水密:未检');
    expect(tip).toContain('材质缺失');
  });
});

describe('M1.5 资产查找与排序(AST-06)', () => {
  const ranked = (id: string, name: string, source: Asset['source'], faces: number, createdAt: number): Asset => asset(
    id,
    name,
    {
      source,
      meta: {
        faces,
        bbox: { min: [0, 0, 0], max: [10, 10, 10] },
        unitChoice: 'mm',
        watertight: true,
        degenerate: false,
        createdAt,
      },
    },
  );

  const tiles = buildTiles(
    [
      ranked('ast_a', 'A 机械齿轮', 'ai', 500, 2),
      ranked('ast_b', 'B 校准方块', 'import', 12, 3),
      ranked('ast_c', 'C 小蘑菇', 'ai', 900, 1),
    ],
    [],
    () => null,
    [],
  );

  it('名称和来源都可搜索', () => {
    expect(filterAndSortTiles(tiles, '齿轮', 'recent').map((tile) => tile.id)).toEqual(['ast_a']);
    expect(filterAndSortTiles(tiles, 'AI', 'recent').map((tile) => tile.id)).toEqual(['ast_a', 'ast_c']);
  });

  it('支持最近、名称、面数排序', () => {
    expect(filterAndSortTiles(tiles, '', 'recent').map((tile) => tile.id)).toEqual(['ast_b', 'ast_a', 'ast_c']);
    expect(filterAndSortTiles(tiles, '', 'name').map((tile) => tile.id)).toEqual(['ast_a', 'ast_b', 'ast_c']);
    expect(filterAndSortTiles(tiles, '', 'faces').map((tile) => tile.id)).toEqual(['ast_c', 'ast_a', 'ast_b']);
  });
});
