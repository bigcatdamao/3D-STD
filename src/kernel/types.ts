export type Vec3 = [number, number, number];

export interface Transform {
  position: Vec3;
  rotation: Vec3; // 欧拉角为源数据,固定 XYZ 序,禁止从矩阵反解回写(技术方案 §3)
  scale: Vec3;
}

export type AssetSource = 'import' | 'ai';
export type AssetState = 'parsing' | 'ready' | 'failed' | 'expired';

export interface AssetMeta {
  faces: number;
  bbox: { min: Vec3; max: Vec3 };
  unitChoice: 'mm' | 'cm' | 'inch' | 'm';
  watertight: boolean | null; // null = 未检
  degenerate: boolean | null;
  vertices?: number; // 焊接后唯一顶点数(IMP-07 网格统计;T10 起由解析管线填写)
  materialMissing?: boolean; // OBJ 缺 MTL 降级默认材质的标记(IMP-07;T11 面板呈现)
  createdAt?: number; // 入库时间戳(AST-02;演示夹具无此字段,面板排序时垫底)
}

export interface Asset {
  id: string;
  name: string;
  source: AssetSource;
  meta: AssetMeta;
  genParams?: Record<string, unknown>; // AI 资产:prompt/引擎/配置(AST-02)
  state: AssetState;
}

export interface NodeFlags {
  visible: boolean; // 隐藏 = 不渲染、不检查、不导出(C7)
  locked: boolean; // 锁定 = 视口不可选不可变换,树内可管理(C7)
}

export interface InstanceNode extends NodeFlags {
  kind: 'instance';
  id: string;
  name: string;
  assetId: string; // 实例引用资产(C2)
  parentId: string | null; // null = 根层级
  transform: Transform;
  materialOverride?: Record<string, unknown>;
}

export interface GroupNode extends NodeFlags {
  kind: 'group';
  id: string;
  name: string;
  parentId: string | null;
}

export type SceneNode = InstanceNode | GroupNode;

export const ROOT = '__root__';

export function defaultTransform(): Transform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}
