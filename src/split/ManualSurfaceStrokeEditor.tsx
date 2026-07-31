import { Html, Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Vec3 } from '../kernel/types';
import { doc, geometryRegistry, useUi } from '../state/store';
import { interactionState } from '../viewport/interaction';
import {
  closeManualSurfaceGuidePoints,
  manualPlaneSplitIsStale,
  replaceManualSurfaceGuidePoints,
  useManualPlaneSplit,
} from './manual-plane-split-state';
import { simplifySurfaceStroke } from './surface-stroke-core';
import {
  recordSurfaceStrokeSegment,
  useSurfaceWorkflow,
  type SurfaceStrokeInputKind,
} from './surface-workflow-state';

interface ActiveStroke {
  pointerId: number;
  original: Vec3[];
  draft: Vec3[];
  downClientX: number;
  downClientY: number;
  lastClientX: number;
  lastClientY: number;
  moved: boolean;
  closeCandidate: boolean;
}

function matrixOfTransform(transform: {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}): THREE.Matrix4 {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(transform.rotation[0]),
    THREE.MathUtils.degToRad(transform.rotation[1]),
    THREE.MathUtils.degToRad(transform.rotation[2]),
    'XYZ',
  );
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.position),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(...transform.scale),
  );
}

function pointDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function mergeGuidePoints(
  original: readonly Vec3[],
  draft: readonly Vec3[],
  epsilon: number,
): Vec3[] {
  const merged = original.map((point) => [...point] as Vec3);
  for (const point of draft) {
    const previous = merged.at(-1);
    if (!previous || pointDistance(previous, point) > epsilon) {
      merged.push([...point] as Vec3);
    }
    if (merged.length >= 256) break;
  }
  return merged;
}

export function ManualSurfaceStrokeEditor() {
  const { camera, gl } = useThree();
  const phase = useManualPlaneSplit((state) => state.phase);
  const cutKind = useManualPlaneSplit((state) => state.cutKind);
  const instanceId = useManualPlaneSplit((state) => state.instanceId);
  const points = useManualPlaneSplit((state) => state.surfaceGuidePoints);
  const closed = useManualPlaneSplit((state) => state.surfaceGuideClosed);
  const bounds = useManualPlaneSplit((state) => state.bounds);
  const mode = useSurfaceWorkflow((state) => state.mode);
  const active = useRef<ActiveStroke | null>(null);
  const pointsRef = useRef(points);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const instance = instanceId ? doc.nodes.get(instanceId) : undefined;
  const transform = instance?.kind === 'instance' ? instance.transform : null;
  const sourceGeometry = instance?.kind === 'instance'
    ? geometryRegistry.get(instance.assetId)
    : undefined;
  const worldMatrix = useMemo(
    () => transform ? matrixOfTransform(transform) : new THREE.Matrix4(),
    [transform],
  );
  const inverseWorldMatrix = useMemo(() => worldMatrix.clone().invert(), [worldMatrix]);
  const pickGeometry = useMemo(() => {
    if (!sourceGeometry) return null;
    const geometry = sourceGeometry.clone();
    geometry.boundsTree = new MeshBVH(geometry, {
      maxLeafTris: 24,
      setBoundingBox: true,
      verbose: false,
    });
    return geometry;
  }, [sourceGeometry]);
  const diagonal = useMemo(() => {
    if (!bounds) return 100;
    return Math.max(1, Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ));
  }, [bounds]);
  const visible = (
    mode === 'stroke'
    && cutKind === 'surface'
    && (phase === 'editing' || phase === 'error')
    && Boolean(instanceId)
    && Boolean(transform)
    && Boolean(pickGeometry?.boundsTree)
    && !manualPlaneSplitIsStale()
  );
  const editable = visible && !closed;
  const displayPoints = useMemo(() => (
    closed && points.length > 2
      ? [...points, points[0]]
      : points
  ), [closed, points]);

  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  useEffect(() => {
    if (!editable || !pickGeometry?.boundsTree) return;
    const canvas = gl.domElement;
    const bvh = pickGeometry.boundsTree;
    const localRay = new THREE.Ray();
    const worldPoint = new THREE.Vector3();
    const projected = new THREE.Vector3();
    const pointEpsilon = Math.max(0.02, diagonal * 0.00008);

    const canvasRect = () => canvas.getBoundingClientRect();
    const toNdc = (clientX: number, clientY: number) => {
      const rect = canvasRect();
      return new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
    };
    const hitAt = (clientX: number, clientY: number) => {
      raycaster.setFromCamera(toNdc(clientX, clientY), camera);
      localRay.copy(raycaster.ray).applyMatrix4(inverseWorldMatrix);
      return bvh.raycastFirst(localRay, THREE.DoubleSide);
    };
    const worldPointOf = (hit: THREE.Intersection): Vec3 => {
      worldPoint.copy(hit.point).applyMatrix4(worldMatrix);
      return [worldPoint.x, worldPoint.y, worldPoint.z];
    };
    const projectToClient = (point: Vec3): { x: number; y: number } | null => {
      projected.set(...point).project(camera);
      if (
        !Number.isFinite(projected.x)
        || !Number.isFinite(projected.y)
        || projected.z < -1
        || projected.z > 1
      ) return null;
      const rect = canvasRect();
      return {
        x: rect.left + ((projected.x + 1) * 0.5) * rect.width,
        y: rect.top + ((1 - projected.y) * 0.5) * rect.height,
      };
    };
    const bridgeFromLastPoint = (
      original: readonly Vec3[],
      targetClientX: number,
      targetClientY: number,
    ): Vec3[] | null => {
      const last = original.at(-1);
      if (!last) {
        const hit = hitAt(targetClientX, targetClientY);
        return hit?.point ? [worldPointOf(hit)] : null;
      }
      const start = projectToClient(last);
      if (!start) {
        useUi.getState().setToast('当前末端不在视野内，请先右键旋转到能看到青色末端的位置');
        return null;
      }
      const pixelDistance = Math.hypot(targetClientX - start.x, targetClientY - start.y);
      const stepCount = Math.max(1, Math.min(48, Math.ceil(pixelDistance / 7)));
      const bridge: Vec3[] = [[...last] as Vec3];
      let hitCount = 0;
      for (let step = 1; step <= stepCount; step += 1) {
        const t = step / stepCount;
        const hit = hitAt(
          start.x + (targetClientX - start.x) * t,
          start.y + (targetClientY - start.y) * t,
        );
        if (!hit?.point) continue;
        const next = worldPointOf(hit);
        const previous = bridge.at(-1)!;
        if (pointDistance(previous, next) > diagonal * 0.16) continue;
        if (pointDistance(previous, next) > pointEpsilon) bridge.push(next);
        hitCount += 1;
      }
      const minimumHits = Math.max(1, Math.ceil(stepCount * 0.55));
      if (hitCount < minimumHits || bridge.length < 2) {
        useUi.getState().setToast('两点之间没有找到连续可见表面，请旋转模型后从末端附近继续');
        return null;
      }
      return bridge;
    };
    const combinedOf = (current: ActiveStroke): Vec3[] => (
      mergeGuidePoints(current.original, current.draft, pointEpsilon)
    );
    const finish = (restore = false) => {
      const current = active.current;
      if (!current) return;
      if (restore) {
        replaceManualSurfaceGuidePoints(current.original);
      } else {
        const remainingBudget = Math.max(2, 257 - current.original.length);
        const simplifiedDraft = simplifySurfaceStroke(
          current.draft,
          Math.max(0.12, diagonal * 0.00065),
          Math.min(64, remainingBudget),
        );
        let combined = mergeGuidePoints(
          current.original,
          simplifiedDraft,
          pointEpsilon,
        );
        if (current.closeCandidate && !current.moved && combined.length > 3) {
          const first = combined[0];
          const last = combined.at(-1)!;
          if (pointDistance(first, last) <= Math.max(pointEpsilon * 2, diagonal * 0.003)) {
            combined = combined.slice(0, -1);
          }
        }
        if (combined.length > current.original.length) {
          replaceManualSurfaceGuidePoints(combined);
          const kind: SurfaceStrokeInputKind = current.moved ? 'draw' : 'click';
          recordSurfaceStrokeSegment(combined.length, kind);
          if (current.closeCandidate && !current.moved) {
            closeManualSurfaceGuidePoints();
          }
        } else {
          replaceManualSurfaceGuidePoints(current.original);
        }
      }
      if (canvas.hasPointerCapture?.(current.pointerId)) {
        canvas.releasePointerCapture(current.pointerId);
      }
      active.current = null;
      interactionState.active = false;
      canvas.style.cursor = 'crosshair';
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || active.current) return;
      const original = pointsRef.current.map((point) => [...point] as Vec3);
      const startClient = original.length >= 3 ? projectToClient(original[0]) : null;
      const closeCandidate = Boolean(
        startClient
        && Math.hypot(event.clientX - startClient.x, event.clientY - startClient.y) <= 18,
      );
      const draft = bridgeFromLastPoint(original, event.clientX, event.clientY);
      if (!draft) return;
      active.current = {
        pointerId: event.pointerId,
        original,
        draft,
        downClientX: event.clientX,
        downClientY: event.clientY,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        moved: false,
        closeCandidate,
      };
      replaceManualSurfaceGuidePoints(mergeGuidePoints(original, draft, pointEpsilon));
      canvas.setPointerCapture?.(event.pointerId);
      interactionState.active = true;
      event.preventDefault();
    };
    const onMove = (event: PointerEvent) => {
      const current = active.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const gestureDistance = Math.hypot(
        event.clientX - current.downClientX,
        event.clientY - current.downClientY,
      );
      if (gestureDistance >= 4 && !current.moved) {
        current.moved = true;
        if (current.closeCandidate) {
          current.closeCandidate = false;
          const restarted = bridgeFromLastPoint(
            current.original,
            event.clientX,
            event.clientY,
          );
          if (restarted) current.draft = restarted;
        }
      }
      if (!current.moved) return;
      const sampleDistance = Math.hypot(
        event.clientX - current.lastClientX,
        event.clientY - current.lastClientY,
      );
      if (sampleDistance < 4) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (!hit || current.original.length + current.draft.length >= 257) return;
      const point = worldPointOf(hit);
      const previous = current.draft.at(-1);
      if (previous && pointDistance(previous, point) < pointEpsilon) return;
      current.draft.push(point);
      current.lastClientX = event.clientX;
      current.lastClientY = event.clientY;
      replaceManualSurfaceGuidePoints(combinedOf(current));
      event.preventDefault();
    };
    const onUp = (event: PointerEvent) => {
      if (active.current?.pointerId !== event.pointerId) return;
      finish(false);
      event.preventDefault();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !active.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(true);
    };
    const onBlur = () => finish(true);
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onBlur);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onBlur);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      finish(true);
      canvas.style.cursor = '';
    };
  }, [
    camera,
    diagonal,
    editable,
    gl,
    inverseWorldMatrix,
    pickGeometry,
    raycaster,
    worldMatrix,
  ]);

  useEffect(() => () => {
    pickGeometry?.dispose();
  }, [pickGeometry]);

  if (!visible || !instance || instance.kind !== 'instance') return null;

  return (
    <>
      {displayPoints.length >= 2 && (
        <Line
          points={displayPoints}
          color={closed ? '#72f0c1' : '#8ce9d0'}
          lineWidth={4}
          transparent
          opacity={1}
          depthTest={false}
          renderOrder={1006}
        />
      )}
      {!closed && points.length > 0 && (
        <Html
          position={points[0]}
          center
          zIndexRange={[40, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="surface-stroke-endpoint is-start" aria-hidden="true">
            <i />
            <span>{points.length >= 3 ? '起点 · 点击闭合' : '起点'}</span>
          </div>
        </Html>
      )}
      {!closed && points.length > 1 && (
        <Html
          position={points.at(-1)!}
          center
          zIndexRange={[39, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="surface-stroke-endpoint is-end" aria-hidden="true">
            <i />
            <span>末端 · 从这里续画</span>
          </div>
        </Html>
      )}
    </>
  );
}
