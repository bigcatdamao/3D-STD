// HIST-07 条目命名规范表 —— 操作类型 → 图标 + 基础显示文案的唯一权威源。
// 规则:每条历史记录必须携带 OpKind;条目 label 由调用点在基础文案上追加上下文
//(计数/对象名),但操作语义只允许从本表取词,禁止在调用点自造新操作名。
// 图标沿用场景树的 emoji 字形体系(T7:👁/🔒/🔓),同一语义同一字形。

export type OpKind =
  | 'place' // 导入落场(HIST-05:撤销移除实例、资产保留)
  | 'aiPlace' // AI 生成落入(T16 汇聚点使用;入栈规则同 place)
  | 'remove' // 删除实例/组
  | 'removeAsset' // 删除资产级联(AST 边界 6)
  | 'rename'
  | 'show'
  | 'hide'
  | 'lock'
  | 'unlock'
  | 'material' // 材质覆盖(整体或逐参数)
  | 'group'
  | 'ungroup'
  | 'reorder' // 同层排序(TREE 拖拽)
  | 'reparent' // 跨层移动(移入组/移至根)
  | 'transform' // 参数面板数值通道(C6 绝对值语义)
  | 'gizmo' // 视口拖拽通道(C6 相对增量语义;含直接拖动)
  | 'drop' // 沉底(VIEW-06;T14 悬空修复复用同语义)
  | 'fix'; // 打印检查确定性修复:移回床内(CHK-06)

export const OP_TABLE: Record<OpKind, { icon: string; name: string }> = {
  place: { icon: '📥', name: '导入' },
  aiPlace: { icon: '✨', name: 'AI 生成落入' },
  remove: { icon: '🗑️', name: '删除' },
  removeAsset: { icon: '🗑️', name: '删除资产' },
  rename: { icon: '✏️', name: '重命名' },
  show: { icon: '👁', name: '显示' },
  hide: { icon: '🙈', name: '隐藏' },
  lock: { icon: '🔒', name: '锁定' },
  unlock: { icon: '🔓', name: '解锁' },
  material: { icon: '🎨', name: '材质' },
  group: { icon: '📁', name: '成组' },
  ungroup: { icon: '📂', name: '解组' },
  reorder: { icon: '↕️', name: '排序' },
  reparent: { icon: '↪️', name: '移动层级' },
  transform: { icon: '📐', name: '数值变换' },
  gizmo: { icon: '✥', name: '拖拽变换' },
  drop: { icon: '⬇️', name: '沉底' },
  fix: { icon: '🩹', name: '修复' },
};
