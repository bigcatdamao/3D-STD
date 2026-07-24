import { TransformControls } from '@react-three/drei';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  setManualPlanePosition,
  setManualPlaneRotation,
  setManualPlaneSize,
  useManualPlaneSplit,
} from './manual-plane-split-state';

const PLANE_GEOMETRY = new THREE.PlaneGeometry(1, 1);
const FRAME_GEOMETRY = new THREE.EdgesGeometry(PLANE_GEOMETRY);

function radians(rotation: [number, number, number]): [number, number, number] {
  return rotation.map(THREE.MathUtils.degToRad) as [number, number, number];
}

/** Blender 式切割平面:由 TransformControls 直接操控，侧栏与视口双向同步。 */
export function ManualPlaneCutManipulator() {
  const phase = useManualPlaneSplit((state) => state.phase);
  const position = useManualPlaneSplit((state) => state.position);
  const rotation = useManualPlaneSplit((state) => state.rotation);
  const size = useManualPlaneSplit((state) => state.size);
  const mode = useManualPlaneSplit((state) => state.mode);
  const group = useRef<THREE.Group>(null!);
  const materialFront = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#55c9ff',
    transparent: true,
    opacity: 0.16,
    side: THREE.FrontSide,
    depthWrite: false,
    depthTest: false,
  }), []);
  const materialBack = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#d192ea',
    transparent: true,
    opacity: 0.14,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  }), []);
  const frameMaterial = useMemo(() => new THREE.LineBasicMaterial({
    color: '#ffb454',
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  }), []);

  if (phase === 'idle') return null;

  const syncFromObject = () => {
    const object = group.current;
    if (!object || phase === 'running') return;
    if (mode === 'translate') {
      setManualPlanePosition([object.position.x, object.position.y, object.position.z]);
    } else if (mode === 'rotate') {
      setManualPlaneRotation([
        THREE.MathUtils.radToDeg(object.rotation.x),
        THREE.MathUtils.radToDeg(object.rotation.y),
        THREE.MathUtils.radToDeg(object.rotation.z),
      ]);
    } else {
      setManualPlaneSize([Math.abs(object.scale.x), Math.abs(object.scale.y)]);
    }
  };

  return (
    <TransformControls
      object={group}
      enabled={phase !== 'running'}
      mode={mode}
      space={mode === 'translate' ? 'world' : 'local'}
      size={0.82}
      showX
      showY
      showZ={mode !== 'scale'}
      translationSnap={0.5}
      rotationSnap={THREE.MathUtils.degToRad(1)}
      onObjectChange={syncFromObject}
    >
      <group
        ref={group}
        position={position}
        rotation={radians(rotation)}
        scale={[size[0], size[1], 1]}
        renderOrder={990}
      >
        <mesh geometry={PLANE_GEOMETRY} material={materialFront} renderOrder={990} />
        <mesh geometry={PLANE_GEOMETRY} material={materialBack} renderOrder={990} />
        <lineSegments geometry={FRAME_GEOMETRY} material={frameMaterial} renderOrder={991} />
        <lineSegments renderOrder={992}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              count={4}
              array={new Float32Array([
                -0.5, 0, 0.002, 0.5, 0, 0.002,
                0, -0.5, 0.002, 0, 0.5, 0.002,
              ])}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial color="#ffd498" transparent opacity={0.72} depthTest={false} />
        </lineSegments>
      </group>
    </TransformControls>
  );
}
