import { Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { doc, geometryRegistry } from '../state/store';
import { interactionState } from '../viewport/interaction';
import {
  boundarySegmentsFromTopology,
  buildFacePaintTopology,
  connectedSurfaceCandidates,
  faceCountOfGeometry,
  type FacePaintTopology,
} from './face-paint-core';
import {
  applyFacePaintFaces,
  beginFacePaintStroke,
  cancelFacePaintStroke,
  commitFacePaintStroke,
  getFacePaintLastChangedFaces,
  getFacePaintMask,
  initializeFacePaintSession,
  registerFacePaintGeometry,
  registerFacePaintTopology,
  setFacePaintBoundaryInfo,
  useFacePaint,
} from './face-paint-state';
import { manualPlaneSplitIsStale, useManualPlaneSplit } from './manual-plane-split-state';

const CURSOR_COLOR = '#ffd073';
const PATCH_COLOR = new THREE.Color('#bd7cff');
const UP = new THREE.Vector3(0, 0, 1);

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

function paintOverlayGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  const faceCount = faceCountOfGeometry(geometry);
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(faceCount * 9), 3));
  return geometry;
}

function writeOverlayFaces(
  geometry: THREE.BufferGeometry,
  mask: Uint8Array,
  faceIndices: Iterable<number>,
): void {
  const color = geometry.getAttribute('color') as THREE.BufferAttribute;
  for (const faceIndex of faceIndices) {
    if (faceIndex < 0 || faceIndex >= mask.length) continue;
    const active = mask[faceIndex] === 1;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = faceIndex * 3 + corner;
      color.setXYZ(
        vertex,
        active ? PATCH_COLOR.r : 0,
        active ? PATCH_COLOR.g : 0,
        active ? PATCH_COLOR.b : 0,
      );
    }
  }
  color.needsUpdate = true;
}

function FacePaintSessionEditor({
  instanceId,
  assetId,
}: {
  instanceId: string;
  assetId: string;
}) {
  const { camera, gl } = useThree();
  const mode = useFacePaint((state) => state.mode);
  const brushRadiusMm = useFacePaint((state) => state.brushRadiusMm);
  const maskRevision = useFacePaint((state) => state.maskRevision);
  const paintedFaceCount = useFacePaint((state) => state.paintedFaceCount);
  const seamStatus = useFacePaint((state) => state.seamStatus);
  const seamResult = useFacePaint((state) => state.seamResult);
  const instance = doc.nodes.get(instanceId);
  const sourceGeometry = geometryRegistry.get(assetId);
  const cursorRef = useRef<THREE.Mesh>(null);
  const boundaryGeometry = useMemo(() => new THREE.BufferGeometry(), []);
  const topologyRef = useRef<FacePaintTopology | null | undefined>(undefined);
  const modeRef = useRef(mode);
  const radiusRef = useRef(brushRadiusMm);
  const activePointerRef = useRef<number | null>(null);
  const pendingFrameRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    paint: boolean;
  } | null>(null);

  const transform = instance?.kind === 'instance' ? instance.transform : null;
  const worldMatrix = useMemo(
    () => transform ? matrixOfTransform(transform) : new THREE.Matrix4(),
    [transform],
  );
  const inverseWorldMatrix = useMemo(() => worldMatrix.clone().invert(), [worldMatrix]);
  const minimumScale = useMemo(() => {
    if (!transform) return 1;
    return Math.max(1e-4, Math.min(...transform.scale.map((value) => Math.abs(value))));
  }, [transform]);
  const pickGeometry = useMemo(() => {
    if (!sourceGeometry) return null;
    const geometry = sourceGeometry.clone();
    geometry.boundsTree = new MeshBVH(geometry, {
      maxLeafTris: 18,
      setBoundingBox: true,
      verbose: false,
    });
    return geometry;
  }, [sourceGeometry]);
  const overlayGeometry = useMemo(
    () => pickGeometry ? paintOverlayGeometry(pickGeometry) : null,
    [pickGeometry],
  );
  const overlayMaterial = useMemo(() => new THREE.ShaderMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide,
    vertexShader: `
      attribute vec3 color;
      varying vec3 vPaintColor;
      void main() {
        vPaintColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPaintColor;
      void main() {
        if (max(max(vPaintColor.r, vPaintColor.g), vPaintColor.b) < 0.01) discard;
        gl_FragColor = vec4(vPaintColor, 0.82);
      }
    `,
  }), []);
  const seamPoints = useMemo(() => {
    if (seamStatus !== 'ready' || !seamResult || seamResult.loopPositions.length < 9) return [];
    const points: THREE.Vector3[] = [];
    for (let index = 0; index < seamResult.loopPositions.length; index += 3) {
      points.push(new THREE.Vector3(
        seamResult.loopPositions[index],
        seamResult.loopPositions[index + 1],
        seamResult.loopPositions[index + 2],
      ));
    }
    points.push(points[0].clone());
    return points;
  }, [seamResult, seamStatus]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    radiusRef.current = brushRadiusMm;
  }, [brushRadiusMm]);

  useEffect(() => {
    if (!pickGeometry || !transform) return;
    const faceCount = faceCountOfGeometry(pickGeometry);
    pickGeometry.computeBoundingBox();
    const diagonal = pickGeometry.boundingBox?.getSize(new THREE.Vector3()).length() ?? 100;
    const worldDiagonal = diagonal * Math.max(...transform.scale.map((value) => Math.abs(value)));
    const defaultRadius = Math.max(1.5, Math.min(40, worldDiagonal * 0.045));
    initializeFacePaintSession(instanceId, assetId, faceCount, defaultRadius);
    registerFacePaintGeometry(pickGeometry);
  }, [assetId, instanceId, pickGeometry, transform]);

  useEffect(() => {
    const mask = getFacePaintMask();
    if (!mask || !overlayGeometry) return;
    const changedFaces = getFacePaintLastChangedFaces();
    if (changedFaces.length) {
      writeOverlayFaces(overlayGeometry, mask, changedFaces);
    } else {
      writeOverlayFaces(overlayGeometry, mask, mask.keys());
    }

    if (paintedFaceCount === 0) {
      boundaryGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      setFacePaintBoundaryInfo('ready', 0);
      return;
    }
    if (topologyRef.current === undefined && pickGeometry) {
      topologyRef.current = buildFacePaintTopology(pickGeometry);
      registerFacePaintTopology(topologyRef.current);
    }
    const boundary = boundarySegmentsFromTopology(topologyRef.current ?? null, mask);
    boundaryGeometry.setAttribute('position', new THREE.BufferAttribute(boundary.positions, 3));
    boundaryGeometry.computeBoundingSphere();
    setFacePaintBoundaryInfo(boundary.status, boundary.segmentCount);
  }, [
    boundaryGeometry,
    maskRevision,
    overlayGeometry,
    paintedFaceCount,
    pickGeometry,
  ]);

  useEffect(() => {
    if (
      seamStatus === 'ready'
      || !pickGeometry?.boundsTree
      || !overlayGeometry
      || !transform
    ) {
      if (cursorRef.current) cursorRef.current.visible = false;
      return;
    }
    const canvas = gl.domElement;
    const bvh = pickGeometry.boundsTree;
    const raycaster = new THREE.Raycaster();
    const localRay = new THREE.Ray();
    const localPoint = new THREE.Vector3();
    const closest = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const localRadius = () => radiusRef.current / minimumScale;

    const toNdc = (clientX: number, clientY: number): THREE.Vector2 => {
      const rect = canvas.getBoundingClientRect();
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

    const updateCursor = (hit: THREE.Intersection | null | undefined) => {
      const cursor = cursorRef.current;
      if (!cursor || !hit?.point || hit.faceIndex == null) {
        if (cursor) cursor.visible = false;
        return;
      }
      cursor.visible = true;
      cursor.position.copy(hit.point);
      normal.copy(hit.face?.normal ?? UP).normalize();
      cursor.quaternion.setFromUnitVectors(UP, normal);
      const radius = localRadius();
      cursor.scale.set(radius, radius, radius);
    };

    const paintAt = (
      clientX: number,
      clientY: number,
      ctrlKey: boolean,
      shouldPaint: boolean,
    ) => {
      const hit = hitAt(clientX, clientY);
      updateCursor(hit);
      if (!shouldPaint || !hit?.point) return;
      localPoint.copy(hit.point);
      const radius = localRadius();
      const radiusSq = radius * radius;
      const faces: number[] = [];
      bvh.shapecast({
        intersectsBounds: (box) => box.distanceToPoint(localPoint) <= radius,
        intersectsTriangle: (triangle, triangleIndex) => {
          triangle.closestPointToPoint(localPoint, closest);
          if (closest.distanceToSquared(localPoint) <= radiusSq) faces.push(triangleIndex);
          return false;
        },
      });
      const connectedFaces = connectedSurfaceCandidates(
        pickGeometry,
        faces,
        hit.faceIndex ?? -1,
        hit.face?.normal,
      );
      const changed = applyFacePaintFaces(
        connectedFaces,
        ctrlKey ? 'erase' : modeRef.current,
      );
      const mask = getFacePaintMask();
      if (changed.length && mask) writeOverlayFaces(overlayGeometry, mask, changed);
    };

    const schedule = (
      clientX: number,
      clientY: number,
      ctrlKey: boolean,
      paint: boolean,
    ) => {
      pendingMoveRef.current = { clientX, clientY, ctrlKey, paint };
      if (pendingFrameRef.current != null) return;
      pendingFrameRef.current = window.requestAnimationFrame(() => {
        pendingFrameRef.current = null;
        const pending = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (pending) paintAt(pending.clientX, pending.clientY, pending.ctrlKey, pending.paint);
      });
    };

    const finishStroke = (cancel: boolean) => {
      const pointerId = activePointerRef.current;
      if (pointerId == null) return;
      if (pendingFrameRef.current != null) {
        window.cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
      pendingMoveRef.current = null;
      cancel ? cancelFacePaintStroke() : commitFacePaintStroke();
      if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
      activePointerRef.current = null;
      interactionState.active = false;
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || activePointerRef.current != null) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (!hit?.point || !beginFacePaintStroke()) return;
      activePointerRef.current = event.pointerId;
      interactionState.active = true;
      canvas.setPointerCapture?.(event.pointerId);
      updateCursor(hit);
      paintAt(event.clientX, event.clientY, event.ctrlKey || event.metaKey, true);
      event.preventDefault();
    };

    const onMove = (event: PointerEvent) => {
      const isPainting = activePointerRef.current === event.pointerId;
      if (activePointerRef.current != null && !isPainting) return;
      if (!isPainting && event.buttons !== 0) {
        if (cursorRef.current) cursorRef.current.visible = false;
        return;
      }
      schedule(
        event.clientX,
        event.clientY,
        event.ctrlKey || event.metaKey,
        isPainting,
      );
      if (isPainting) event.preventDefault();
    };

    const onUp = (event: PointerEvent) => {
      if (activePointerRef.current !== event.pointerId) return;
      paintAt(event.clientX, event.clientY, event.ctrlKey || event.metaKey, true);
      finishStroke(false);
      event.preventDefault();
    };

    const onCancel = () => finishStroke(true);
    const onLeave = () => {
      if (activePointerRef.current == null && cursorRef.current) cursorRef.current.visible = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || activePointerRef.current == null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finishStroke(true);
    };

    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerleave', onLeave);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onCancel);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onCancel);
      if (pendingFrameRef.current != null) window.cancelAnimationFrame(pendingFrameRef.current);
      finishStroke(true);
      canvas.style.cursor = '';
    };
  }, [
    camera,
    gl,
    inverseWorldMatrix,
    minimumScale,
    overlayGeometry,
    pickGeometry,
    seamStatus,
    transform,
  ]);

  useEffect(() => () => {
    pickGeometry?.dispose();
    overlayGeometry?.dispose();
    overlayMaterial.dispose();
    boundaryGeometry.dispose();
  }, [boundaryGeometry, overlayGeometry, overlayMaterial, pickGeometry]);

  if (!instance || instance.kind !== 'instance' || !sourceGeometry || !overlayGeometry) return null;
  const D2R = Math.PI / 180;

  return (
    <group
      position={instance.transform.position}
      rotation={instance.transform.rotation.map((value) => value * D2R) as [number, number, number]}
      scale={instance.transform.scale}
    >
      <mesh
        geometry={overlayGeometry}
        material={overlayMaterial}
        renderOrder={1003}
      />
      {seamStatus !== 'ready' && (
        <lineSegments geometry={boundaryGeometry} renderOrder={1004}>
          <lineBasicMaterial
            color="#ffd073"
            depthTest={false}
            depthWrite={false}
            transparent
            opacity={0.96}
          />
        </lineSegments>
      )}
      {seamPoints.length > 1 && (
        <Line
          points={seamPoints}
          color="#72f0c1"
          lineWidth={4}
          depthTest={false}
          transparent
          opacity={1}
          renderOrder={1006}
        />
      )}
      <mesh ref={cursorRef} visible={false} renderOrder={1005}>
        <ringGeometry args={[0.93, 1, 48]} />
        <meshBasicMaterial
          color={CURSOR_COLOR}
          depthTest={false}
          depthWrite={false}
          transparent
          opacity={0.96}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

/**
 * Blender Draw Face Sets inspired editor. M1.11b freezes painting after a
 * validated closed seam is generated, while orbit/pan/zoom remain available.
 */
export function ManualFacePaintEditor() {
  const phase = useManualPlaneSplit((state) => state.phase);
  const cutKind = useManualPlaneSplit((state) => state.cutKind);
  const instanceId = useManualPlaneSplit((state) => state.instanceId);
  const assetId = useManualPlaneSplit((state) => state.sourceAssetId);
  if (
    cutKind !== 'surface'
    || (phase !== 'editing' && phase !== 'error')
    || !instanceId
    || !assetId
    || manualPlaneSplitIsStale()
  ) return null;
  return <FacePaintSessionEditor key={`${instanceId}:${assetId}`} instanceId={instanceId} assetId={assetId} />;
}
