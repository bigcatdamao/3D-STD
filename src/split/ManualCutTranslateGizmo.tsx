import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useUi } from '../state/store';
import {
  AXIS_UNIT,
  axisHandleDisabled,
  closestParamOnAxis,
  fmtSigned,
  gizmoWorldScale,
} from '../viewport/gizmo-math';
import { interactionState } from '../viewport/interaction';
import {
  setManualPlanePosition,
  useManualPlaneSplit,
} from './manual-plane-split-state';

const AXIS_COLORS = ['#ef5f5b', '#5bd26c', '#578eff'] as const;
const AXIS_LABELS = 'XYZ';
const AXIS_ROT: [number, number, number][] = [
  [0, 0, -Math.PI / 2],
  [0, 0, 0],
  [Math.PI / 2, 0, 0],
];
const SHAFT = new THREE.CylinderGeometry(0.026, 0.026, 0.72, 12);
const HEAD = new THREE.ConeGeometry(0.085, 0.24, 16);
const PICKER = new THREE.CylinderGeometry(0.14, 0.14, 1.18, 10);
const CENTER = new THREE.SphereGeometry(0.095, 16, 12);
const PICK_MATERIAL = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthTest: false,
  depthWrite: false,
});
const GIZMO_PX = 112;

interface DragState {
  axis: 0 | 1 | 2;
  pointerId: number;
  startParam: number;
  startPosition: [number, number, number];
  pivot: THREE.Vector3;
}

function snapHalfMillimeter(value: number): number {
  return Math.round(value * 2) / 2;
}

export function ManualCutTranslateGizmo() {
  const { camera, gl, size } = useThree();
  const phase = useManualPlaneSplit((state) => state.phase);
  const position = useManualPlaneSplit((state) => state.position);
  const group = useRef<THREE.Group>(null);
  const drag = useRef<DragState | null>(null);
  const disabledAxes = useRef([false, false, false]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const materials = useMemo(
    () => AXIS_COLORS.map((color) => new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    })),
    [],
  );

  useEffect(() => () => {
    for (const material of materials) material.dispose();
  }, [materials]);

  const pointerRay = (event: PointerEvent): THREE.Ray => {
    const rect = gl.domElement.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    return raycaster.ray;
  };

  const finishDrag = (restore = false) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (restore) setManualPlanePosition(current.startPosition);
    gl.domElement.releasePointerCapture?.(current.pointerId);
    gl.domElement.style.cursor = '';
    useUi.getState().setHud(null);
    interactionState.active = false;
    setActive(null);
    window.removeEventListener('pointermove', onWindowMove);
    window.removeEventListener('pointerup', onWindowUp);
    window.removeEventListener('pointercancel', onWindowCancel);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('keydown', onWindowKey, true);
  };

  const onWindowMove = (event: PointerEvent) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      finishDrag();
      return;
    }
    event.preventDefault();
    const nextParam = closestParamOnAxis(pointerRay(event), current.pivot, AXIS_UNIT[current.axis]);
    if (nextParam == null) return;
    const delta = snapHalfMillimeter(nextParam - current.startParam);
    const next = [...current.startPosition] as [number, number, number];
    next[current.axis] = snapHalfMillimeter(current.startPosition[current.axis] + delta);
    setManualPlanePosition(next);
    const rect = gl.domElement.getBoundingClientRect();
    useUi.getState().setHud({
      text: `${AXIS_LABELS[current.axis]} ${next[current.axis].toFixed(1)} mm · Δ${fmtSigned(delta)} mm`,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const onWindowUp = (event: PointerEvent) => {
    if (drag.current && event.pointerId === drag.current.pointerId) finishDrag();
  };

  const onWindowCancel = (event: PointerEvent) => {
    if (drag.current && event.pointerId === drag.current.pointerId) finishDrag();
  };

  const onWindowBlur = () => finishDrag();

  const onWindowKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !drag.current) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finishDrag(true);
  };

  const startDrag = (axis: 0 | 1 | 2, event: ThreeEvent<PointerEvent>) => {
    if (phase === 'running' || disabledAxes.current[axis]) return;
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    const pivot = new THREE.Vector3(...position);
    const startParam = closestParamOnAxis(event.ray, pivot, AXIS_UNIT[axis]);
    if (startParam == null) return;
    drag.current = {
      axis,
      pointerId: event.pointerId,
      startParam,
      startPosition: [...position],
      pivot,
    };
    gl.domElement.setPointerCapture?.(event.pointerId);
    gl.domElement.style.cursor = 'grabbing';
    interactionState.active = true;
    setActive(axis);
    setHovered(axis);
    window.addEventListener('pointermove', onWindowMove, { passive: false });
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowCancel);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('keydown', onWindowKey, true);
  };

  useEffect(() => () => finishDrag(), []);

  const viewDirection = useMemo(() => new THREE.Vector3(), []);
  const pivot = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const root = group.current;
    if (!root) return;
    pivot.set(position[0], position[1], position[2]);
    root.position.copy(pivot);
    root.scale.setScalar(gizmoWorldScale(camera, pivot, size.height, GIZMO_PX));
    camera.getWorldDirection(viewDirection);
    for (const axis of [0, 1, 2] as const) {
      disabledAxes.current[axis] = axisHandleDisabled(axis, viewDirection);
      const material = materials[axis];
      material.color.set(
        disabledAxes.current[axis]
          ? '#59606d'
          : active === axis
            ? '#ffb454'
            : hovered === axis
              ? '#ffe0ac'
              : AXIS_COLORS[axis],
      );
      material.opacity = disabledAxes.current[axis] ? 0.32 : 1;
    }
  });

  if (phase === 'running') return null;
  return (
    <group ref={group} renderOrder={1000}>
      <mesh geometry={CENTER} renderOrder={1000}>
        <meshBasicMaterial color="#ffcc84" depthTest={false} depthWrite={false} />
      </mesh>
      {([0, 1, 2] as const).map((axis) => (
        <group key={axis} rotation={AXIS_ROT[axis]}>
          <mesh geometry={SHAFT} material={materials[axis]} position={[0, 0.48, 0]} renderOrder={1001} />
          <mesh geometry={HEAD} material={materials[axis]} position={[0, 0.94, 0]} renderOrder={1001} />
          <mesh
            geometry={PICKER}
            material={PICK_MATERIAL}
            position={[0, 0.56, 0]}
            renderOrder={1002}
            onPointerDown={(event) => startDrag(axis, event)}
            onPointerOver={(event) => {
              event.stopPropagation();
              if (!disabledAxes.current[axis] && active == null) {
                setHovered(axis);
                gl.domElement.style.cursor = 'grab';
              }
            }}
            onPointerOut={() => {
              if (active == null) {
                setHovered(null);
                gl.domElement.style.cursor = '';
              }
            }}
          />
        </group>
      ))}
    </group>
  );
}
