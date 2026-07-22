import * as THREE from 'three';
import { doc, useUi } from '../state/store';
import {
  getRepairAddedGeometry,
  getRepairPreviewGeometry,
  getRepairRemovedGeometry,
  meshRepairPreviewIsStale,
  useMeshRepair,
} from './mesh-repair-state';

export function RepairPreviewMesh() {
  useUi((state) => state.rev);
  const phase = useMeshRepair((state) => state.phase);
  const instanceId = useMeshRepair((state) => state.instanceId);
  const previewMode = useMeshRepair((state) => state.previewMode);
  if (phase !== 'ready' || !instanceId || meshRepairPreviewIsStale()) return null;
  const node = doc.nodes.get(instanceId);
  const repaired = getRepairPreviewGeometry();
  const added = getRepairAddedGeometry();
  const removed = getRepairRemovedGeometry();
  if (!node || node.kind !== 'instance' || !repaired) return null;
  const [px, py, pz] = node.transform.position;
  const [rx, ry, rz] = node.transform.rotation.map(THREE.MathUtils.degToRad) as [number, number, number];
  const [sx, sy, sz] = node.transform.scale;

  return (
    <group position={[px, py, pz]} rotation={[rx, ry, rz]} scale={[sx, sy, sz]}>
      {previewMode === 'overlay' && (
        <mesh geometry={repaired} renderOrder={4}>
          <meshBasicMaterial
            color="#5dcaa5"
            transparent
            opacity={0.16}
            depthWrite={false}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-2}
          />
        </mesh>
      )}
      {added && (
        <mesh geometry={added} renderOrder={5}>
          <meshStandardMaterial
            color="#6fffc8"
            emissive="#1c7c5c"
            emissiveIntensity={0.75}
            transparent
            opacity={0.92}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {removed && (
        <mesh geometry={removed} renderOrder={6}>
          <meshStandardMaterial
            color="#ff7f7f"
            emissive="#8d2f3a"
            emissiveIntensity={0.85}
            transparent
            opacity={0.95}
            depthWrite={false}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
    </group>
  );
}
