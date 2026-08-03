import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { doc, geometryRegistry, meshRegistry } from '../state/store';
import {
  analyzeConnectorCandidate,
  assessConnectorPairCandidate,
  matrixOfTransform,
  type ConnectorCandidate,
} from './connector-geometry';
import {
  chooseConnectorCandidate,
  connectorIsStale,
  getConnectorPreviewGeometries,
  setConnectorHover,
  useConnector,
} from './connector-state';

const raycaster = new THREE.Raycaster();

function candidateFromPointer(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  phase: 'pickFirst' | 'pickSecond',
  firstInstanceId: string,
  diameterMm: number,
): ConnectorCandidate | null {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const candidates: THREE.Object3D[] = [];
  for (const [id, object] of meshRegistry) {
    const node = doc.nodes.get(id);
    if (!node || node.kind !== 'instance' || !doc.effectiveVisible(id) || doc.effectiveLocked(id)) continue;
    if (phase === 'pickFirst' ? id !== firstInstanceId : id === firstInstanceId) continue;
    candidates.push(object);
  }
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(candidates, false)[0];
  if (!hit) return null;
  const id = hit.object.userData.instanceId as string;
  const node = doc.nodes.get(id);
  if (!node || node.kind !== 'instance') return null;
  const geometry = geometryRegistry.get(node.assetId);
  if (!geometry || !hit.face) return null;
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  return analyzeConnectorCandidate(node, geometry, hit.point, normal, hit.faceIndex ?? null, diameterMm);
}

function Marker({ candidate, selected = false }: { candidate: ConnectorCandidate; selected?: boolean }) {
  const color = candidate.rating === 'invalid' ? '#f06770' : candidate.rating === 'warning' ? '#ffb454' : '#63d3ac';
  const point = new THREE.Vector3(...candidate.point);
  const normal = new THREE.Vector3(...candidate.normal);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  return (
    <group position={point} quaternion={quaternion} renderOrder={20}>
      <mesh>
        <sphereGeometry args={[selected ? 1.8 : 1.45, 20, 14]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={selected ? 1 : .9} />
      </mesh>
      <mesh position={[0, 4, 0]}>
        <cylinderGeometry args={[0.38, 0.38, 8, 12]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={.85} />
      </mesh>
      <mesh position={[0, 8.4, 0]}>
        <coneGeometry args={[1.2, 3, 14]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
    </group>
  );
}

function DirectionLine({ from, to }: { from: [number, number, number]; to: [number, number, number] }) {
  const geometry = useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.Float32BufferAttribute([...from, ...to], 3));
    return next;
  }, [from[0], from[1], from[2], to[0], to[1], to[2]]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments geometry={geometry} renderOrder={19}>
      <lineBasicMaterial color="#bff7df" depthTest={false} transparent opacity={.95} />
    </lineSegments>
  );
}

function PreviewPair() {
  const state = useConnector();
  if (state.phase !== 'previewReady' || !state.firstInstanceId || !state.secondInstanceId || connectorIsStale()) return null;
  const [firstGeometry, secondGeometry] = getConnectorPreviewGeometries();
  if (!firstGeometry || !secondGeometry) return null;
  const first = doc.nodes.get(state.firstInstanceId);
  const second = doc.nodes.get(state.secondInstanceId);
  if (!first || first.kind !== 'instance' || !second || second.kind !== 'instance') return null;
  const firstMatrix = matrixOfTransform(first.transform);
  const secondMatrix = matrixOfTransform(second.transform);
  return (
    <group>
      <mesh geometry={firstGeometry} matrix={firstMatrix} matrixAutoUpdate={false} renderOrder={8}>
        <meshStandardMaterial color="#55d2a9" roughness={.5} metalness={.03} transparent opacity={.96} />
      </mesh>
      <mesh geometry={secondGeometry} matrix={secondMatrix} matrixAutoUpdate={false} renderOrder={8}>
        <meshStandardMaterial color="#b07aef" roughness={.5} metalness={.03} transparent opacity={.96} />
      </mesh>
    </group>
  );
}

export function ConnectorViewport() {
  const { gl, camera } = useThree();
  const state = useConnector();
  const pickable = state.phase === 'pickFirst' || state.phase === 'pickSecond';

  useEffect(() => {
    if (!pickable || !state.firstInstanceId) return;
    const canvas = gl.domElement;
    let lastAt = 0;
    const update = (event: PointerEvent) => {
      const now = performance.now();
      if (event.type === 'pointermove' && now - lastAt < 28) return;
      lastAt = now;
      const rawCandidate = candidateFromPointer(
        event,
        canvas,
        camera,
        state.phase as 'pickFirst' | 'pickSecond',
        state.firstInstanceId!,
        state.parameters.diameterMm,
      );
      const candidate = rawCandidate && state.phase === 'pickSecond' && state.first
        ? assessConnectorPairCandidate(state.first, rawCandidate, state.parameters)
        : rawCandidate;
      setConnectorHover(candidate);
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const rawCandidate = candidateFromPointer(
        event,
        canvas,
        camera,
        state.phase as 'pickFirst' | 'pickSecond',
        state.firstInstanceId!,
        state.parameters.diameterMm,
      );
      const candidate = rawCandidate && state.phase === 'pickSecond' && state.first
        ? assessConnectorPairCandidate(state.first, rawCandidate, state.parameters)
        : rawCandidate;
      if (!candidate) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      chooseConnectorCandidate(candidate);
    };
    const leave = () => setConnectorHover(null);
    canvas.addEventListener('pointermove', update, true);
    canvas.addEventListener('pointerdown', down, true);
    canvas.addEventListener('pointerleave', leave, true);
    return () => {
      canvas.removeEventListener('pointermove', update, true);
      canvas.removeEventListener('pointerdown', down, true);
      canvas.removeEventListener('pointerleave', leave, true);
    };
  }, [camera, gl, pickable, state.first, state.firstInstanceId, state.parameters, state.phase]);

  const lineEnd: [number, number, number] | null = state.first
    ? state.second?.point
      ?? state.hover?.point
      ?? new THREE.Vector3(...state.first.point)
        .addScaledVector(new THREE.Vector3(...state.first.normal), Math.max(36, state.parameters.depthMm * 4))
        .toArray() as [number, number, number]
    : null;

  return (
    <group>
      {state.first && <Marker candidate={state.first} selected />}
      {state.second && <Marker candidate={state.second} selected />}
      {state.hover && <Marker candidate={state.hover} />}
      {state.first && lineEnd && <DirectionLine from={state.first.point} to={lineEnd} />}
      <PreviewPair />
    </group>
  );
}
