import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { doc, geometryRegistry, useUi } from '../state/store';
import { planeCutPreviewIsStale, usePlaneCutPreview } from './plane-cut-state';

const SIDE_A = '#50c8ff';
const SIDE_B = '#c98ee0';
const CUT = '#ffb454';

function CutPlaneVisual({ axisIndex, position, min, max }: {
  axisIndex: 0 | 1 | 2;
  position: number;
  min: [number, number, number];
  max: [number, number, number];
}) {
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  center[axisIndex] = position;
  const dimensions = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const other = ([0, 1, 2] as const).filter((axis) => axis !== axisIndex);
  const size: [number, number] = [Math.max(dimensions[other[0]] * 1.12, 1), Math.max(dimensions[other[1]] * 1.12, 1)];
  const rotation: [number, number, number] = axisIndex === 0
    ? [0, Math.PI / 2, 0]
    : axisIndex === 1 ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  return (
    <group position={center} rotation={rotation}>
      <mesh renderOrder={8}>
        <planeGeometry args={size} />
        <meshBasicMaterial color={CUT} side={THREE.DoubleSide} transparent opacity={0.16} depthWrite={false} />
      </mesh>
      <lineSegments renderOrder={9}>
        <edgesGeometry args={[new THREE.PlaneGeometry(...size)]} />
        <lineBasicMaterial color={CUT} depthTest={false} />
      </lineSegments>
    </group>
  );
}

export function PlaneCutPreview() {
  useUi((state) => state.rev);
  useUi((state) => state.bed);
  const phase = usePlaneCutPreview((state) => state.phase);
  const instanceId = usePlaneCutPreview((state) => state.instanceId);
  const candidates = usePlaneCutPreview((state) => state.candidates);
  const activeIndex = usePlaneCutPreview((state) => state.activeIndex);
  if (phase !== 'ready' || !instanceId || planeCutPreviewIsStale()) return null;
  const instance = doc.nodes.get(instanceId);
  if (!instance || instance.kind !== 'instance') return null;
  const geometry = geometryRegistry.get(instance.assetId);
  const candidate = candidates[activeIndex];
  if (!geometry || !candidate) return null;

  const normal = new THREE.Vector3(0, 0, 0);
  normal.setComponent(candidate.axisIndex, 1);
  const keepLow = new THREE.Plane(normal, -candidate.positionMm);
  const keepHigh = keepLow.clone().negate();
  const transform = instance.transform;
  const D2R = Math.PI / 180;
  const overall = {
    min: candidate.parts[0].bounds.min,
    max: candidate.parts[1].bounds.max,
  };
  const centerOf = (part: 0 | 1): [number, number, number] => {
    const bounds = candidate.parts[part].bounds;
    return [0, 1, 2].map((axis) => (bounds.min[axis] + bounds.max[axis]) / 2) as [number, number, number];
  };

  return (
    <group>
      <group
        position={transform.position}
        rotation={transform.rotation.map((value) => value * D2R) as [number, number, number]}
        scale={transform.scale}
      >
        <mesh geometry={geometry} renderOrder={6}>
          <meshStandardMaterial
            color={SIDE_A}
            clippingPlanes={[keepHigh]}
            side={THREE.DoubleSide}
            roughness={0.55}
            metalness={0.05}
            transparent
            opacity={0.9}
          />
        </mesh>
        <mesh geometry={geometry} renderOrder={6}>
          <meshStandardMaterial
            color={SIDE_B}
            clippingPlanes={[keepLow]}
            side={THREE.DoubleSide}
            roughness={0.55}
            metalness={0.05}
            transparent
            opacity={0.9}
          />
        </mesh>
      </group>
      <CutPlaneVisual
        axisIndex={candidate.axisIndex}
        position={candidate.positionMm}
        min={overall.min}
        max={overall.max}
      />
      <Html position={centerOf(0)} center style={{ pointerEvents: 'none' }}>
        <div className="plane-cut-preview-label side-a">A · 包围盒估算</div>
      </Html>
      <Html position={centerOf(1)} center style={{ pointerEvents: 'none' }}>
        <div className="plane-cut-preview-label side-b">B · 包围盒估算</div>
      </Html>
      <Html
        position={[
          (overall.min[0] + overall.max[0]) / 2,
          (overall.min[1] + overall.max[1]) / 2,
          overall.max[2] + Math.max(5, (overall.max[2] - overall.min[2]) * 0.12),
        ]}
        center
        style={{ pointerEvents: 'none' }}
      >
        <div className="plane-cut-preview-label cut">{candidate.label} · 只读切割预览</div>
      </Html>
    </group>
  );
}
