// 场景实例渲染 —— 单一事实源在内核:每帧渲染树由 doc.nodes 派生,组件不持有场景副本。
// 选中描边(VIEW-04 统一描边)用反向壳(BackSide 放大壳),透视/正交均稳定,零后处理依赖。

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { InstanceNode } from '../kernel/types';
import { doc, geometryRegistry, meshRegistry, useUi } from '../state/store';

const SELECT_OUTLINE = '#ffb454';
const BODY_COLORS = ['#5dcaa5', '#6aa9e8', '#c98ee0', '#8b8b93'];
const LOCKED_COLOR = '#55555e';

function colorFor(assetId: string): string {
  let h = 0;
  for (let i = 0; i < assetId.length; i++) h = (h * 31 + assetId.charCodeAt(i)) >>> 0;
  return BODY_COLORS[h % BODY_COLORS.length];
}

function InstanceMesh({ node, selected }: { node: InstanceNode; selected: boolean }) {
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
      <mesh ref={ref} geometry={geo} userData={{ instanceId: node.id, locked: node.locked }}>
        <meshStandardMaterial
          color={node.locked ? LOCKED_COLOR : colorFor(node.assetId)}
          roughness={0.55}
          metalness={0.05}
          transparent={node.locked}
          opacity={node.locked ? 0.75 : 1}
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
    (n): n is InstanceNode => n.kind === 'instance' && n.visible, // C7:隐藏 = 不渲染
  );
  return (
    <group>
      {nodes.map((n) => (
        <InstanceMesh key={n.id} node={n} selected={doc.selection.has(n.id)} />
      ))}
    </group>
  );
}
