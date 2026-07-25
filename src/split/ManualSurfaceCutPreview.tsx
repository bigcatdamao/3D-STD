import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { doc } from '../state/store';
import { useManualPlaneSplit } from './manual-plane-split-state';

function makeGeometry(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Real A/B curved-cut preview. The source instance stays intact until confirmation. */
export function ManualSurfaceCutPreview() {
  const phase = useManualPlaneSplit((state) => state.phase);
  const cutKind = useManualPlaneSplit((state) => state.cutKind);
  const instanceId = useManualPlaneSplit((state) => state.instanceId);
  const result = useManualPlaneSplit((state) => state.surfaceResult);
  const geometries = useMemo(() => {
    if (!result) return null;
    const seam = new THREE.BufferGeometry();
    seam.setAttribute('position', new THREE.BufferAttribute(result.seamPositions, 3));
    return {
      a: makeGeometry(result.partA.positions),
      b: makeGeometry(result.partB.positions),
      seam,
    };
  }, [result]);

  useEffect(() => () => {
    geometries?.a.dispose();
    geometries?.b.dispose();
    geometries?.seam.dispose();
  }, [geometries]);

  if (
    cutKind !== 'surface'
    || phase !== 'previewReady'
    || !instanceId
    || !result
    || !geometries
  ) return null;

  const instance = doc.nodes.get(instanceId);
  if (!instance || instance.kind !== 'instance') return null;
  const D2R = Math.PI / 180;
  return (
    <group
      position={instance.transform.position}
      rotation={instance.transform.rotation.map((value) => value * D2R) as [number, number, number]}
      scale={instance.transform.scale}
    >
      <mesh geometry={geometries.a} renderOrder={981}>
        <meshStandardMaterial
          color="#50c8ff"
          side={THREE.DoubleSide}
          roughness={0.55}
          metalness={0.05}
          transparent
          opacity={0.94}
          depthWrite
        />
      </mesh>
      <mesh geometry={geometries.b} renderOrder={981}>
        <meshStandardMaterial
          color="#c98ee0"
          side={THREE.DoubleSide}
          roughness={0.55}
          metalness={0.05}
          transparent
          opacity={0.94}
          depthWrite
        />
      </mesh>
      <lineSegments geometry={geometries.seam} renderOrder={995}>
        <lineBasicMaterial color="#fff1a8" depthTest={false} transparent opacity={1} />
      </lineSegments>
    </group>
  );
}
