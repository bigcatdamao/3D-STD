// 场景实例渲染 —— 单一事实源在内核:每帧渲染树由 doc.nodes 派生,组件不持有场景副本。
// 选中描边(VIEW-04 统一描边)用反向壳(BackSide 放大壳),透视/正交均稳定,零后处理依赖。

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { InstanceNode } from '../kernel/types';
import { doc, geometryRegistry, meshRegistry, useUi } from '../state/store';

const SELECT_OUTLINE = '#ffb454';
const BODY_COLORS = ['#5dcaa5', '#6aa9e8', '#c98ee0', '#e8a15d'];
const LOCKED_COLOR = '#55555e';

// 体色按资产首次出现顺序取色,不再哈希 —— T5 验收记录的视觉债:哈希撞色使圆柱与扭结
// 同落灰色,与锁定态灰难区分;灰色自此专属锁定态,调色板内不再含灰(T6 顺手清偿)。
const colorAssign = new Map<string, string>();
function colorFor(assetId: string): string {
  let c = colorAssign.get(assetId);
  if (!c) {
    c = BODY_COLORS[colorAssign.size % BODY_COLORS.length];
    colorAssign.set(assetId, c);
  }
  return c;
}

function InstanceMesh({
  node,
  selected,
  locked,
}: {
  node: InstanceNode;
  selected: boolean;
  locked: boolean; // 等效锁定(自身或随组,C7)
}) {
  const ref = useRef<THREE.Mesh>(null);
  const geo = geometryRegistry.get(node.assetId);

  // mesh 注册表:聚焦包围盒与框选投影的数据来源
  useEffect(() => {
    if (ref.current) meshRegistry.set(node.id, ref.current);
    return () => {
      meshRegistry.delete(node.id);
    };
  }, [node.id]);

  const outlineGeo = useMemo(() => geo, [geo]);
  if (!geo) return null;

  const [px, py, pz] = node.transform.position;
  const [rx, ry, rz] = node.transform.rotation;
  const [sx, sy, sz] = node.transform.scale;
  const D2R = Math.PI / 180;

  return (
    <group
      position={[px, py, pz]}
      rotation={[rx * D2R, ry * D2R, rz * D2R]} // 欧拉源数据,固定 XYZ 序(C6/技术方案 §3)
      scale={[sx, sy, sz]}
    >
      <mesh ref={ref} geometry={geo} userData={{ instanceId: node.id, locked }}>
        <meshStandardMaterial
          color={locked ? LOCKED_COLOR : colorFor(node.assetId)}
          roughness={0.55}
          metalness={0.05}
          transparent={locked}
          opacity={locked ? 0.75 : 1}
        />
      </mesh>
      {selected && outlineGeo && (
        <mesh geometry={outlineGeo} scale={[1.045, 1.045, 1.045]} renderOrder={1}>
          <meshBasicMaterial color={SELECT_OUTLINE} side={THREE.BackSide} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

export function SceneInstances() {
  useUi((s) => s.rev); // 订阅文档版本:任何 command 后重派生
  const nodes = [...doc.nodes.values()].filter(
    (n): n is InstanceNode => n.kind === 'instance' && doc.effectiveVisible(n.id), // C7:隐藏(含随组隐藏)= 不渲染
  );
  return (
    <group>
      {nodes.map((n) => (
        <InstanceMesh
          key={n.id}
          node={n}
          selected={doc.selection.has(n.id)}
          locked={doc.effectiveLocked(n.id)}
        />
      ))}
    </group>
  );
}
