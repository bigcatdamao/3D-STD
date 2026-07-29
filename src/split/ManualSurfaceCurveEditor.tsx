import { Line } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { doc, geometryRegistry } from '../state/store';
import { interactionState } from '../viewport/interaction';
import {
  appendManualSurfaceGuidePoint,
  manualPlaneSplitIsStale,
  moveManualSurfaceGuidePoint,
  useManualPlaneSplit,
} from './manual-plane-split-state';

interface PointDrag {
  index: number;
  pointerId: number;
  original: [number, number, number];
}

/**
 * 3DCoat 式贴面曲线编辑器：
 * 左键命中目标表面添加控制点；拖动已有控制点时持续射线吸附回目标表面。
 * 曲线与控制点都只存在于工具状态，不写场景历史。
 */
export function ManualSurfaceCurveEditor() {
  const { camera, gl } = useThree();
  const phase = useManualPlaneSplit((state) => state.phase);
  const cutKind = useManualPlaneSplit((state) => state.cutKind);
  const instanceId = useManualPlaneSplit((state) => state.instanceId);
  const bounds = useManualPlaneSplit((state) => state.bounds);
  const points = useManualPlaneSplit((state) => state.surfaceGuidePoints);
  const closed = useManualPlaneSplit((state) => state.surfaceGuideClosed);
  const pickMesh = useRef<THREE.Mesh>(null);
  const drag = useRef<PointDrag | null>(null);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const pointRadius = useMemo(() => {
    if (!bounds) return 2.5;
    const diagonal = Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    );
    return Math.max(1.3, Math.min(6, diagonal * 0.009));
  }, [bounds]);

  useEffect(() => {
    const canvas = gl.domElement;
    const toNdc = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };
    const finish = (restore = false) => {
      const active = drag.current;
      if (!active) return;
      if (restore) moveManualSurfaceGuidePoint(active.index, active.original);
      if (canvas.hasPointerCapture?.(active.pointerId)) {
        canvas.releasePointerCapture(active.pointerId);
      }
      drag.current = null;
      interactionState.active = false;
      canvas.style.cursor = '';
    };
    const onMove = (event: PointerEvent) => {
      const active = drag.current;
      const target = pickMesh.current;
      if (!active || !target) return;
      target.updateWorldMatrix(true, false);
      raycaster.setFromCamera(toNdc(event), camera);
      const hit = raycaster.intersectObject(target, false)[0];
      if (!hit) return;
      moveManualSurfaceGuidePoint(active.index, [hit.point.x, hit.point.y, hit.point.z]);
      canvas.style.cursor = 'grabbing';
      event.preventDefault();
    };
    const onUp = (event: PointerEvent) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      finish(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(true);
    };
    const onBlur = () => finish(true);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onBlur);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onBlur);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      finish(false);
    };
  }, [camera, gl, raycaster]);

  if (
    cutKind !== 'surface'
    || (phase !== 'editing' && phase !== 'error' && phase !== 'previewing')
    || !instanceId
    || manualPlaneSplitIsStale()
  ) return null;
  const instance = doc.nodes.get(instanceId);
  if (!instance || instance.kind !== 'instance') return null;
  const geometry = geometryRegistry.get(instance.assetId);
  if (!geometry) return null;
  const D2R = Math.PI / 180;
  const linePoints = closed && points.length >= 3 ? [...points, points[0]] : points;
  const editable = phase === 'editing' || phase === 'error';

  const beginPointDrag = (index: number) => (event: ThreeEvent<PointerEvent>) => {
    if (!editable || event.button !== 0) return;
    event.stopPropagation();
    event.nativeEvent.preventDefault();
    drag.current = {
      index,
      pointerId: event.pointerId,
      original: [...points[index]],
    };
    gl.domElement.setPointerCapture?.(event.pointerId);
    interactionState.active = true;
    gl.domElement.style.cursor = 'grabbing';
  };

  return (
    <>
      <group
        position={instance.transform.position}
        rotation={instance.transform.rotation.map((value) => value * D2R) as [number, number, number]}
        scale={instance.transform.scale}
      >
        <mesh
          ref={pickMesh}
          geometry={geometry}
          onPointerDown={(event) => {
            if (!editable || event.button !== 0 || drag.current) return;
            event.stopPropagation();
            appendManualSurfaceGuidePoint([event.point.x, event.point.y, event.point.z]);
          }}
        >
          <meshBasicMaterial
            transparent
            opacity={0}
            colorWrite={false}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>

      {linePoints.length >= 2 && (
        <Line
          points={linePoints}
          color="#ffd073"
          lineWidth={3}
          transparent
          opacity={0.96}
          depthTest={false}
          renderOrder={1005}
        />
      )}
      {!closed && points.length >= 3 && (
        <Line
          points={[points[points.length - 1], points[0]]}
          color="#7b8794"
          lineWidth={1}
          dashed
          dashSize={pointRadius * 1.4}
          gapSize={pointRadius}
          transparent
          opacity={0.75}
          depthTest={false}
          renderOrder={1004}
        />
      )}
      {points.map((point, index) => (
        <mesh
          key={index}
          position={point}
          renderOrder={1006}
          onPointerDown={editable ? beginPointDrag(index) : undefined}
          onPointerOver={(event) => {
            event.stopPropagation();
            gl.domElement.style.cursor = 'grab';
          }}
          onPointerOut={() => {
            if (!drag.current) gl.domElement.style.cursor = '';
          }}
        >
          <sphereGeometry args={[pointRadius, 16, 12]} />
          <meshBasicMaterial
            color={index === 0 ? '#69d2ae' : '#ffb454'}
            depthTest={false}
            transparent
            opacity={0.98}
          />
        </mesh>
      ))}
    </>
  );
}
