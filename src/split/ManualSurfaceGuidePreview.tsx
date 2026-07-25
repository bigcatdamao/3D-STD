import { useMemo } from 'react';
import * as THREE from 'three';
import { doc, geometryRegistry } from '../state/store';
import {
  manualGuidePlaneWorld,
  manualPlaneSplitIsStale,
  useManualPlaneSplit,
} from './manual-plane-split-state';

/**
 * M1.10a 第一步：平面只负责粗定位。
 * 源模型以切面两侧的蓝/紫穿透效果提示“这里只是定位”，不生成临时零件。
 */
export function ManualSurfaceGuidePreview() {
  const phase = useManualPlaneSplit((state) => state.phase);
  const cutKind = useManualPlaneSplit((state) => state.cutKind);
  const instanceId = useManualPlaneSplit((state) => state.instanceId);
  const position = useManualPlaneSplit((state) => state.position);
  const rotation = useManualPlaneSplit((state) => state.rotation);
  const worldPlane = useMemo(() => {
    const guide = manualGuidePlaneWorld(position, rotation);
    const normal = new THREE.Vector3(...guide.normal).normalize();
    return new THREE.Plane(normal, -normal.dot(new THREE.Vector3(...guide.origin)));
  }, [position, rotation]);

  if (
    cutKind !== 'surface'
    || phase === 'idle'
    || phase === 'previewReady'
    || !instanceId
    || manualPlaneSplitIsStale()
  ) return null;

  const instance = doc.nodes.get(instanceId);
  if (!instance || instance.kind !== 'instance') return null;
  const geometry = geometryRegistry.get(instance.assetId);
  if (!geometry) return null;
  const D2R = Math.PI / 180;
  const opposite = worldPlane.clone().negate();
  return (
    <group
      position={instance.transform.position}
      rotation={instance.transform.rotation.map((value) => value * D2R) as [number, number, number]}
      scale={instance.transform.scale}
    >
      <mesh geometry={geometry} renderOrder={979}>
        <meshStandardMaterial
          color="#50c8ff"
          clippingPlanes={[worldPlane]}
          side={THREE.DoubleSide}
          roughness={0.52}
          metalness={0.04}
          transparent
          opacity={0.72}
          depthWrite={false}
        />
      </mesh>
      <mesh geometry={geometry} renderOrder={979}>
        <meshStandardMaterial
          color="#c98ee0"
          clippingPlanes={[opposite]}
          side={THREE.DoubleSide}
          roughness={0.52}
          metalness={0.04}
          transparent
          opacity={0.72}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
