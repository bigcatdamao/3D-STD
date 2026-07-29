import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
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
  const viewportSize = useThree((state) => state.size);
  const phase = useManualPlaneSplit((state) => state.phase);
  const cutKind = useManualPlaneSplit((state) => state.cutKind);
  const instanceId = useManualPlaneSplit((state) => state.instanceId);
  const result = useManualPlaneSplit((state) => state.surfaceResult);
  const geometries = useMemo(() => {
    if (!result) return null;
    const seamGeometry = new LineSegmentsGeometry();
    seamGeometry.setPositions(result.seamPositions);
    const seamMaterial = new LineMaterial({
      color: '#79f0cc',
      linewidth: 4,
      worldUnits: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 1,
    });
    const seam = new LineSegments2(seamGeometry, seamMaterial);
    seam.computeLineDistances();
    seam.renderOrder = 995;
    return {
      a: makeGeometry(result.partA.positions),
      b: makeGeometry(result.partB.positions),
      seam,
      seamGeometry,
      seamMaterial,
    };
  }, [result]);

  useEffect(() => {
    geometries?.seamMaterial.resolution.set(viewportSize.width, viewportSize.height);
  }, [geometries, viewportSize.height, viewportSize.width]);

  useEffect(() => () => {
    geometries?.a.dispose();
    geometries?.b.dispose();
    geometries?.seamGeometry.dispose();
    geometries?.seamMaterial.dispose();
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
          color="#a86cff"
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
          color="#55d0a4"
          side={THREE.DoubleSide}
          roughness={0.55}
          metalness={0.05}
          transparent
          opacity={0.94}
          depthWrite
        />
      </mesh>
      <primitive object={geometries.seam} />
    </group>
  );
}
