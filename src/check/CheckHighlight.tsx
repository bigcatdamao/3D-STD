// 视口问题高亮(CHK-05)—— 点击结果条目后的定位呈现,一次只亮当前条目:
// · 非水密/退化 → 边界边描红(资产局部线段 × 实例变换)+ 红壳描边;
// · 悬空 → 底面中心到打印床的投影距离线 + 距离标签;
// · 超床/微小件 → 红/琥珀壳描边。
// 过期(CHK-03)或对象已删(边界 2)即熄灭 —— 高亮承诺「问题就在这里」,承诺失效就不再亮。

import { Html } from '@react-three/drei';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { doc, geometryRegistry, useUi } from '../state/store';
import { edgeRegistry, liveIssues, reportIsStale, useCheck } from './check-state';
import type { MeshHealthVec3, SelfIntersectionEvidence } from './mesh-health-core';

const RED = '#f06a6a';
const AMBER = '#ffb454';
const EVIDENCE_A = '#ff596c';
const EVIDENCE_B = '#50c8ff';

export function CheckHighlight() {
  useUi((s) => s.rev);
  useUi((s) => s.bed);
  const activeKey = useCheck((s) => s.activeKey);
  const activeEvidenceIndex = useCheck((s) => s.activeEvidenceIndex);
  const assetMetas = useCheck((s) => s.assetMetas);
  const phase = useCheck((s) => s.phase);

  const issue = liveIssues().find((i) => i.key === activeKey) ?? null;
  const inst = issue ? doc.nodes.get(issue.instanceId) : null;
  const stale = phase === 'done' && reportIsStale();
  const selfIntersectionEvidence = issue?.code === 'self_intersection'
    ? assetMetas.find((meta) => meta.assetId === issue.assetId)?.health.selfIntersectionEvidence ?? []
    : [];
  const selectedEvidence = selfIntersectionEvidence.length
    ? selfIntersectionEvidence[Math.min(activeEvidenceIndex, selfIntersectionEvidence.length - 1)]
    : null;

  const segGeo = useMemo(() => {
    if (!issue || issue.code !== 'non_watertight') return null;
    const segs = edgeRegistry.get(issue.assetId);
    if (!segs || !segs.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(segs, 3));
    return g;
  }, [issue?.assetId, issue?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!issue || !inst || inst.kind !== 'instance' || stale) return null;

  const D2R = Math.PI / 180;
  const t = inst.transform;
  const shellColor = issue.level === 'error' ? RED : AMBER;
  const geo = geometryRegistry.get(inst.assetId);

  return (
    <group>
      {/* 壳描边:与选中壳同法(BackSide 放大),半径再外扩一档,红/琥珀按级别 */}
      {geo && issue.code !== 'dims' && (
        <group
          position={[t.position[0], t.position[1], t.position[2]]}
          rotation={[t.rotation[0] * D2R, t.rotation[1] * D2R, t.rotation[2] * D2R]}
          scale={[t.scale[0], t.scale[1], t.scale[2]]}
        >
          {issue.code !== 'self_intersection' && (
            <mesh geometry={geo} scale={[1.06, 1.06, 1.06]} renderOrder={2}>
              <meshBasicMaterial color={shellColor} side={THREE.BackSide} depthWrite={false} transparent opacity={0.85} />
            </mesh>
          )}
          {/* 非水密:边界边描红(局部坐标线段随实例变换) */}
          {segGeo && (
            <lineSegments geometry={segGeo} renderOrder={3}>
              <lineBasicMaterial color={RED} depthTest={false} />
            </lineSegments>
          )}
          {selectedEvidence && (
            <SelfIntersectionEvidenceHighlight
              evidence={selectedEvidence}
              index={Math.min(activeEvidenceIndex, selfIntersectionEvidence.length - 1)}
              total={selfIntersectionEvidence.length}
            />
          )}
        </group>
      )}

      {/* 悬空:投影距离线(底面中心 → z=0)+ 距离标签(CHK-05「悬空示投影距离」) */}
      {issue.code === 'floating' && issue.world && (
        <FloatDropLine world={issue.world} />
      )}
    </group>
  );
}

function triangleGeometry(points: [MeshHealthVec3, MeshHealthVec3, MeshHealthVec3]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points.flat()), 3));
  geometry.computeVertexNormals();
  return geometry;
}

function triangleEdgeGeometry(points: [MeshHealthVec3, MeshHealthVec3, MeshHealthVec3]): THREE.BufferGeometry {
  const [a, b, c] = points;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    ...a, ...b,
    ...b, ...c,
    ...c, ...a,
  ]), 3));
  return geometry;
}

function SelfIntersectionEvidenceHighlight({
  evidence,
  index,
  total,
}: {
  evidence: SelfIntersectionEvidence;
  index: number;
  total: number;
}) {
  const visual = useMemo(() => {
    const all = [...evidence.triangleA, ...evidence.triangleB];
    const min: MeshHealthVec3 = [Infinity, Infinity, Infinity];
    const max: MeshHealthVec3 = [-Infinity, -Infinity, -Infinity];
    for (const point of all) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }
    const center: MeshHealthVec3 = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    return {
      faceA: triangleGeometry(evidence.triangleA),
      faceB: triangleGeometry(evidence.triangleB),
      edgeA: triangleEdgeGeometry(evidence.triangleA),
      edgeB: triangleEdgeGeometry(evidence.triangleB),
      center,
      markerRadius: Math.max(diagonal * 0.035, 0.15),
    };
  }, [evidence]);

  useEffect(() => () => {
    visual.faceA.dispose();
    visual.faceB.dispose();
    visual.edgeA.dispose();
    visual.edgeB.dispose();
  }, [visual]);

  return (
    <group>
      <mesh geometry={visual.faceA} renderOrder={5}>
        <meshBasicMaterial color={EVIDENCE_A} side={THREE.DoubleSide} depthTest={false} depthWrite={false} transparent opacity={0.82} />
      </mesh>
      <mesh geometry={visual.faceB} renderOrder={5}>
        <meshBasicMaterial color={EVIDENCE_B} side={THREE.DoubleSide} depthTest={false} depthWrite={false} transparent opacity={0.82} />
      </mesh>
      <lineSegments geometry={visual.edgeA} renderOrder={6}>
        <lineBasicMaterial color="#ffd8dd" depthTest={false} />
      </lineSegments>
      <lineSegments geometry={visual.edgeB} renderOrder={6}>
        <lineBasicMaterial color="#d6f4ff" depthTest={false} />
      </lineSegments>
      <mesh position={visual.center} renderOrder={6}>
        <sphereGeometry args={[visual.markerRadius, 18, 12]} />
        <meshBasicMaterial color="#ffffff" depthTest={false} />
      </mesh>
      <Html position={visual.center} center style={{ pointerEvents: 'none' }}>
        <div className="self-intersection-label">
          自交证据 {index + 1}/{total}<br />面 #{evidence.faceA} × #{evidence.faceB}
        </div>
      </Html>
    </group>
  );
}

function FloatDropLine({ world }: { world: { min: [number, number, number]; max: [number, number, number] } }) {
  const cx = (world.min[0] + world.max[0]) / 2;
  const cy = (world.min[1] + world.max[1]) / 2;
  const z = world.min[2];
  const lineGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([cx, cy, z, cx, cy, 0]), 3));
    return g;
  }, [cx, cy, z]);
  const ringGeo = useMemo(() => new THREE.RingGeometry(2.4, 3.4, 32), []);
  return (
    <group>
      <lineSegments geometry={lineGeo} renderOrder={3}>
        <lineBasicMaterial color={AMBER} depthTest={false} />
      </lineSegments>
      {/* 床面落点圈 */}
      <mesh geometry={ringGeo} position={[cx, cy, 0.05]} renderOrder={3}>
        <meshBasicMaterial color={AMBER} side={THREE.DoubleSide} depthTest={false} />
      </mesh>
      <Html position={[cx, cy, z / 2]} center style={{ pointerEvents: 'none' }}>
        <div
          style={{
            background: AMBER,
            color: '#1b1b20',
            fontSize: 11,
            fontWeight: 700,
            padding: '1px 7px',
            borderRadius: 5,
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          悬空 {z.toFixed(1)}mm
        </div>
      </Html>
    </group>
  );
}
