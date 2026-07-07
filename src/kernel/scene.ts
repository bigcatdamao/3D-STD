// SceneDocument —— C2 资产/实例分离、TREE/C7 三状态、HIST 入栈三分类的执行引擎。
// 所有变更必须经 command(commit/interaction/mergedInput)派发,禁止旁路修改(技术方案 §3)。

import { HistoryManager } from './history.js';
import { dedupeName, nextGroupName, sanitizeName } from './naming.js';
import {
  Asset,
  GroupNode,
  InstanceNode,
  ROOT,
  SceneNode,
  Transform,
  defaultTransform,
} from './types.js';

let seq = 0;
const genId = (p: string) => `${p}_${(++seq).toString(36)}`;

const clone = <T>(v: T): T => structuredClone(v);

interface NodeSnapshot {
  existed: boolean;
  node: SceneNode | null;
}

interface StructSnapshot {
  nodes: Map<string, NodeSnapshot>;
  orders: Map<string, string[]>; // parentId(含 ROOT) → 子节点顺序
  assets: Map<string, Asset | null>; // null = 此刻不存在
}

export class SceneDocument {
  assets = new Map<string, Asset>();
  nodes = new Map<string, SceneNode>();
  order = new Map<string, string[]>([[ROOT, []]]);
  selection = new Set<string>();
  readonly history: HistoryManager;

  private interaction: {
    label: string;
    targets: string[];
    before: StructSnapshot;
    selectionBefore: string[];
  } | null = null;

  constructor(history?: HistoryManager) {
    this.history = history ?? new HistoryManager();
    this.history.bindSelection((ids) => {
      this.selection = new Set(ids);
    });
  }

  // ---------- 查询 ----------
  childrenOf(parentId: string | null): string[] {
    return this.order.get(parentId ?? ROOT) ?? [];
  }
  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (nid: string) => {
      for (const c of this.childrenOf(nid)) {
        out.push(c);
        walk(c);
      }
    };
    walk(id);
    return out;
  }
  instance(id: string): InstanceNode {
    const n = this.nodes.get(id);
    if (!n || n.kind !== 'instance') throw new Error(`不是实例: ${id}`);
    return n;
  }

  // ---------- 三状态与层级查询(C7 / TREE-01/02) ----------
  /** C7:组状态对成员为继承式叠加 —— 沿父链任一层隐藏即等效隐藏;成员自身标记保留 */
  effectiveVisible(id: string): boolean {
    let n = this.nodes.get(id);
    if (!n) return false;
    while (n) {
      if (!n.visible) return false;
      n = n.parentId ? this.nodes.get(n.parentId) : undefined;
    }
    return true;
  }
  /** C7:沿父链任一层锁定即等效锁定(视口不可选不可变换;树内仍可管理) */
  effectiveLocked(id: string): boolean {
    let n = this.nodes.get(id);
    while (n) {
      if (n.locked) return true;
      n = n.parentId ? this.nodes.get(n.parentId) : undefined;
    }
    return false;
  }
  /** 层级深度:根层级子节点 = 1(TREE-01 软上限 5 的度量口径) */
  depthOf(id: string): number {
    let d = 0;
    let n = this.nodes.get(id);
    while (n) {
      d += 1;
      n = n.parentId ? this.nodes.get(n.parentId) : undefined;
    }
    return d;
  }
  /** 过滤出集合内的「顶层」节点:祖先也在集合中的成员被剔除(拖拽/成组/删除共用口径) */
  topMost(ids: Iterable<string>): string[] {
    const set = new Set(ids);
    const out: string[] = [];
    for (const id of set) {
      const n = this.nodes.get(id);
      if (!n) continue;
      let p = n.parentId;
      let covered = false;
      while (p) {
        if (set.has(p)) {
          covered = true;
          break;
        }
        p = this.nodes.get(p)?.parentId ?? null;
      }
      if (!covered) out.push(id);
    }
    return out;
  }
  private takenNames(): Set<string> {
    return new Set([...this.nodes.values()].map((n) => n.name));
  }

  // ---------- 选中(不入栈,C1 第三类) ----------
  select(ids: string[]) {
    this.selection = new Set(ids);
  }
  /** VIEW-04:全选跳过锁定对象(含随组锁定的成员,C7 继承式叠加) */
  selectAll() {
    this.selection = new Set(
      [...this.nodes.values()].filter((n) => !this.effectiveLocked(n.id)).map((n) => n.id),
    );
  }

  // ---------- 快照机制 ----------
  private capture(
    nodeIds: Iterable<string>,
    assetIds: Iterable<string> = [],
    extraOrderKeys: Iterable<string> = [], // 前后快照须覆盖同一批顺序表:变更父级的操作,after 侧补 before 的键(redo 对称)
  ): StructSnapshot {
    const nodes = new Map<string, NodeSnapshot>();
    const parents = new Set<string>([ROOT, ...extraOrderKeys]);
    for (const id of nodeIds) {
      const n = this.nodes.get(id) ?? null;
      nodes.set(id, { existed: !!n, node: n ? clone(n) : null });
      if (n?.parentId) parents.add(n.parentId);
      parents.add(id); // 若其本身是组,顺序表也要留底
    }
    const orders = new Map<string, string[]>();
    for (const p of parents) orders.set(p, [...(this.order.get(p) ?? [])]);
    const assets = new Map<string, Asset | null>();
    for (const id of assetIds) assets.set(id, this.assets.has(id) ? clone(this.assets.get(id)!) : null);
    return { nodes, orders, assets };
  }

  private restore(s: StructSnapshot) {
    for (const [id, snap] of s.nodes) {
      if (snap.existed) this.nodes.set(id, clone(snap.node!)); // ID 稳定:同 ID 原样回写(TREE 边界 7)
      else this.nodes.delete(id);
    }
    for (const [p, arr] of s.orders) this.order.set(p, [...arr]);
    for (const [id, a] of s.assets) {
      if (a) this.assets.set(id, clone(a));
      else this.assets.delete(id);
    }
  }

  /** 立即入栈类操作的统一提交通道(C1 第一类) */
  private commit(
    label: string,
    touchedNodeIds: string[],
    mutate: () => void,
    opts: { assetIds?: string[]; mergeKey?: string } = {},
  ) {
    if (this.history.isFrozen) throw new Error('预览态禁用编辑(VIEW-07)');
    const beforeSel = [...this.selection];
    const before = this.capture(touchedNodeIds, opts.assetIds ?? []);
    mutate();
    const after = this.capture(touchedNodeIds, opts.assetIds ?? [], before.orders.keys());
    const afterSel = [...this.selection];
    this.history.push({
      label,
      targetIds: touchedNodeIds,
      apply: () => this.restore(after),
      revert: () => this.restore(before),
      selectionBefore: beforeSel,
      selectionAfter: afterSel,
      mergeKey: opts.mergeKey,
    });
  }

  // ---------- 装载通道 ----------
  /** 项目打开 / 示例场景初始化专用:直接写入文档状态,不产生历史记录。
   *  装载不是编辑(C1 管辖的是用户编辑操作);T17 项目生命周期复用此通道。 */
  hydrate(assets: Asset[], nodes: SceneNode[]) {
    if (this.interaction) throw new Error('交互会话中禁止装载');
    for (const a of assets) this.assets.set(a.id, clone(a));
    for (const n of nodes) this.nodes.set(n.id, clone(n));
    // 依 nodes 传入顺序重建各层级顺序表
    for (const n of nodes) {
      const p = n.parentId ?? ROOT;
      if (!this.order.has(p)) this.order.set(p, []);
      this.order.get(p)!.push(n.id);
      if (n.kind === 'group' && !this.order.has(n.id)) this.order.set(n.id, []);
    }
    this.selection = new Set();
  }

  // ---------- 资产 ----------
  addAsset(a: Omit<Asset, 'id'>): Asset {
    // 资产库操作不入栈(导入解析属资产侧;历史栈只管场景编辑)
    const asset: Asset = { ...clone(a), id: genId('ast') } as Asset;
    this.assets.set(asset.id, asset);
    return asset;
  }

  /** AST 边界 6/场景树边界:删除资产 → 级联删除其全部实例,整体一步 */
  removeAssetCascade(assetId: string) {
    const victims = [...this.nodes.values()]
      .filter((n) => n.kind === 'instance' && n.assetId === assetId)
      .map((n) => n.id);
    this.commit(
      `删除资产及 ${victims.length} 个实例`,
      victims,
      () => {
        for (const id of victims) this.detach(id);
        this.assets.delete(assetId);
        this.selection = new Set([...this.selection].filter((s) => !victims.includes(s)));
      },
      { assetIds: [assetId] },
    );
  }

  // ---------- 实例 ----------
  /** 导入落场 / AI 落入共用:资产 → 根层级新实例,自动选中(TREE 边界 4)。
   *  HIST-05:撤销此步移除实例、资产保留 —— capture 不含 assetId,天然满足。 */
  placeInstance(assetId: string, label = '导入'): InstanceNode {
    const asset = this.assets.get(assetId);
    if (!asset) throw new Error(`资产不存在: ${assetId}`);
    const id = genId('ins');
    const inst: InstanceNode = {
      kind: 'instance',
      id,
      name: dedupeName(asset.name, this.takenNames()), // 实例继承资产名,重复加序号(TREE-05)
      assetId,
      parentId: null,
      transform: defaultTransform(),
      visible: true,
      locked: false,
    };
    this.commit(label, [id], () => {
      this.nodes.set(id, inst);
      this.order.get(ROOT)!.push(id);
      this.selection = new Set([id]);
    });
    return inst;
  }

  /** 多选删除 = 一步(C1);组带内容整树删除(TREE 边界 1) */
  removeNodes(ids: string[]) {
    const full = [...new Set(ids.flatMap((id) => [id, ...this.descendants(id)]))];
    this.commit(`删除 ${ids.length} 个对象`, full, () => {
      for (const id of full) this.detach(id);
      this.selection = new Set([...this.selection].filter((s) => !full.includes(s)));
    });
  }

  private detach(id: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    const arr = this.order.get(n.parentId ?? ROOT);
    if (arr) {
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
    }
    this.order.delete(id);
    this.nodes.delete(id);
  }

  rename(id: string, name: string) {
    const clean = sanitizeName(name);
    if (!clean) return; // 空名不成立,UI 侧还原输入框(允许重名但不允许空名,TREE-05)
    if (this.nodes.get(id)?.name === clean) return; // 无变化不入栈
    this.commit(`重命名 · ${clean}`, [id], () => {
      this.nodes.get(id)!.name = clean;
    });
  }

  setVisible(ids: string[], visible: boolean) {
    this.commit(visible ? '显示' : '隐藏', ids, () => {
      for (const id of ids) this.nodes.get(id)!.visible = visible;
    });
  }

  setLocked(ids: string[], locked: boolean) {
    this.commit(locked ? '锁定' : '解锁', ids, () => {
      for (const id of ids) this.nodes.get(id)!.locked = locked;
    });
  }

  /** PANEL 边界 1:多选批量属性编辑跳过锁定成员,仍是一步 */
  setMaterialOverride(ids: string[], mat: Record<string, unknown>): { skipped: number } {
    const editable = ids.filter((id) => !this.nodes.get(id)?.locked);
    const skipped = ids.length - editable.length;
    this.commit(`修改材质(${editable.length} 个对象)`, editable, () => {
      for (const id of editable) this.instance(id).materialOverride = clone(mat);
    });
    return { skipped };
  }

  // ---------- 组(TREE-04/05,嵌套见 TREE-01) ----------
  /** 成组:成员先做 topMost 过滤(组连同其成员被选时只动组)。
   *  组落位:全体成员同父 → 落该父级、占首成员原位;混合父级 → 落根层级末尾(可预测,信条 4)。
   *  默认名「组 N」(TREE-05)。 */
  group(ids: string[], name?: string): GroupNode {
    const tops = this.topMost(ids);
    if (!tops.length) throw new Error('成组需要至少一个对象');
    const gname = name !== undefined ? sanitizeName(name) || nextGroupName(this.takenNames()) : nextGroupName(this.takenNames());
    const gid = genId('grp');
    const parentSet = new Set(tops.map((id) => this.nodes.get(id)!.parentId ?? ROOT));
    const parentKey = parentSet.size === 1 ? [...parentSet][0] : ROOT;
    const g: GroupNode = {
      kind: 'group',
      id: gid,
      name: gname,
      parentId: parentKey === ROOT ? null : parentKey,
      visible: true,
      locked: false,
    };
    const touched = [gid, ...tops, ...(parentKey === ROOT ? [] : [parentKey])];
    this.commit(`成组 · ${gname}`, touched, () => {
      const parr = this.order.get(parentKey)!;
      const anchor =
        parentSet.size === 1
          ? Math.min(...tops.map((id) => parr.indexOf(id)).filter((i) => i >= 0))
          : Number.MAX_SAFE_INTEGER;
      this.nodes.set(gid, g);
      this.order.set(gid, []);
      for (const id of tops) {
        const n = this.nodes.get(id)!;
        const from = this.order.get(n.parentId ?? ROOT)!;
        from.splice(from.indexOf(id), 1);
        n.parentId = gid;
        this.order.get(gid)!.push(id);
      }
      parr.splice(Math.min(anchor, parr.length), 0, gid);
      this.selection = new Set([gid]);
    });
    return g;
  }

  /** 解组;撤销须还原组名、成员顺序与状态(HIST 边界 4 / TREE 边界 2)——快照机制天然覆盖。
   *  嵌套组解组:成员回填到组所在父级、占组原位(不落根)。 */
  ungroup(gid: string) {
    this.ungroupMany([gid]);
  }

  /** 多选解组 = 一步(C1 批量合并) */
  ungroupMany(gids: string[]) {
    const groups = this.topMost(gids).filter((id) => this.nodes.get(id)?.kind === 'group');
    if (!groups.length) return;
    const members = groups.flatMap((g) => this.childrenOf(g));
    const parents = groups
      .map((g) => this.nodes.get(g)!.parentId)
      .filter((p): p is string => !!p);
    const label = groups.length > 1 ? `解组(${groups.length} 个组)` : '解组';
    this.commit(label, [...groups, ...members, ...parents], () => {
      const sel = new Set<string>();
      for (const g of groups) {
        const node = this.nodes.get(g)!;
        const parentKey = node.parentId ?? ROOT;
        const parr = this.order.get(parentKey)!;
        const at = parr.indexOf(g);
        const ms = [...this.childrenOf(g)];
        for (const id of ms) {
          this.nodes.get(id)!.parentId = node.parentId;
          sel.add(id);
        }
        parr.splice(at, 1, ...ms);
        this.order.delete(g);
        this.nodes.delete(g);
      }
      this.selection = sel;
    });
  }

  /** 拖拽排序与入组(TREE-04)。多选拖拽 = 一步(C1)。
   *  parentId = null 表示根层级;beforeId = null 表示追加末尾。
   *  校验:目标须为组;锁定组不接受拖入(TREE 边界 3,含随组锁定);禁止把组拖入其自身后代(成环)。
   *  深度软上限 5 不在此拦截 —— 超限由 UI 提示(TREE-01「提示不禁止」)。 */
  moveNodes(rawIds: string[], parentId: string | null, beforeId: string | null) {
    const ids = this.topMost(rawIds);
    if (!ids.length) return;
    if (parentId) {
      const p = this.nodes.get(parentId);
      if (!p || p.kind !== 'group') throw new Error(`目标不是组: ${parentId}`);
      if (this.effectiveLocked(parentId)) throw new Error('锁定的组不接受拖入(TREE 边界 3)');
      for (const id of ids) {
        if (id === parentId || this.descendants(id).includes(parentId)) {
          throw new Error('不能将组拖入其自身内部');
        }
      }
    }
    const parentKey = parentId ?? ROOT;
    const sameParent = ids.every((id) => (this.nodes.get(id)!.parentId ?? ROOT) === parentKey);
    const label = sameParent
      ? '排序'
      : parentId
        ? `移入 · ${this.nodes.get(parentId)!.name}`
        : '移至根层级';
    const before = ids.includes(beforeId ?? '') ? null : beforeId;
    this.commit(label, [...ids, ...(parentId ? [parentId] : [])], () => {
      for (const id of ids) {
        const n = this.nodes.get(id)!;
        const from = this.order.get(n.parentId ?? ROOT)!;
        const i = from.indexOf(id);
        if (i >= 0) from.splice(i, 1);
        n.parentId = parentId;
      }
      const arr = this.order.get(parentKey)!;
      const at = before ? arr.indexOf(before) : -1;
      arr.splice(at >= 0 ? at : arr.length, 0, ...ids);
    });
  }

  // ---------- 变换:两个输入通道(C6) ----------
  /** gizmo/滑杆:交互会话 = 一步(C1 第二类)。pointer-down 调 begin,期间任意次 update,pointer-up 调 commit。 */
  beginInteraction(label: string, targets: string[]) {
    if (this.history.isFrozen) throw new Error('预览态禁用编辑(VIEW-07)');
    if (this.interaction) throw new Error('已有进行中的交互会话');
    this.interaction = {
      label,
      targets,
      before: this.capture(targets),
      selectionBefore: [...this.selection],
    };
  }
  updateInteraction(mutate: (doc: this) => void) {
    if (!this.interaction) throw new Error('无进行中的交互会话');
    mutate(this);
  }
  /** VIEW 边界 4:Esc 取消 → 回起点、不入栈 */
  cancelInteraction() {
    if (!this.interaction) return;
    this.restore(this.interaction.before);
    this.interaction = null;
  }
  commitInteraction() {
    const s = this.interaction;
    if (!s) throw new Error('无进行中的交互会话');
    this.interaction = null;
    const after = this.capture(s.targets, [], s.before.orders.keys());
    this.history.push({
      label: s.label,
      targetIds: s.targets,
      apply: () => this.restore(after),
      revert: () => this.restore(s.before),
      selectionBefore: s.selectionBefore,
      selectionAfter: [...this.selection],
    });
  }

  /** 参数面板数值键入:同字段 800ms 内合并(C1 第二类)。rotation 归一在此完成且不产生额外记录(PANEL-05)。 */
  setTransformField(
    id: string,
    field: keyof Transform,
    axis: 0 | 1 | 2,
    value: number,
  ) {
    if (field === 'scale' && value <= 0) value = 0.001; // clamp ≥0.1%(PANEL-05)
    if (field === 'rotation') value = normalizeDeg(value);
    this.commit(
      `设置 ${field}.${'xyz'[axis]}`,
      [id],
      () => {
        this.instance(id).transform[field][axis] = value;
      },
      { mergeKey: `input:${id}:${field}:${axis}` },
    );
  }

  /** VIEW-06 沉底:底面 Z 归零(此内核以 bbox 近似;几何精确版在检查 Worker 中) */
  dropToBed(ids: string[], zMinOf: (inst: InstanceNode) => number) {
    this.commit('沉底', ids, () => {
      for (const id of ids) {
        const inst = this.instance(id);
        inst.transform.position[2] -= zMinOf(inst);
      }
    });
  }
}

/** 旋转归一到 (-180, 180](PANEL-05) */
export function normalizeDeg(deg: number): number {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d === -180 ? 180 : d;
}
