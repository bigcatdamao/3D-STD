// Gizmo(T6 · VIEW-05):W/E/R 三模式、世界轴对齐(切片软件习惯,设计信条 1)。
// 职责切分:本组件只管「长什么样」——摆位(选中集包围盒中心)、屏幕等距缩放、
// 启用态判定与高亮着色;拾取与拖拽全部在 interaction.ts 状态机 + gizmo-math.ts 纯函数,
// 把手网格经 gizmoHandles 注册表交给交互层。

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { doc, expandToInstances, gizmoHandles, gizmoUiState, useUi } from '../state/store';
import {
  GizmoPart,
  axisHandleDisabled,
  gizmoWorldScale,
  partKey,
  planeHandleDisabled,
  selectionBBox,
} from './gizmo-math';

// ---------- 视觉常量 ----------

const AXIS_COLORS = ['#e0605d', '#5dca6a', '#5d8fe8']; // X 红 / Y 绿 / Z 蓝(行业惯例)
const UNIFORM_COLOR = '#d3d3da';
const HOVER_COLOR = '#ffd9a3';
const ACTIVE_COLOR = '#ffb454'; // 与选中描边同色系
const DISABLED_COLOR = '#55555e';
const GIZMO_PX = 92; // 屏幕视觉尺寸(半径 1 世界单位 ≈ 92px)

/** 把 +Y 基准几何对齐到各世界轴的旋转 */
const AXIS_ROT: [number, number, number][] = [
  [0, 0, -Math.PI / 2], // +Y → +X
  [0, 0, 0],
  [Math.PI / 2, 0, 0], // +Y → +Z
];
/** 把法线 +Z 的平面几何对齐到各法线轴的旋转 */
const NORMAL_ROT: [number, number, number][] = [
  [0, Math.PI / 2, 0], // 法线 → X(YZ 面)
  [-Math.PI / 2, 0, 0], // 法线 → Y(XZ 面)
  [0, 0, 0], // 法线 → Z(XY 面)
];

// 共享几何(基准:轴长 1;实际大小由 group 缩放决定)
const GEO = {
  shaft: new THREE.CylinderGeometry(0.02, 0.02, 0.72, 12),
  head: new THREE.ConeGeometry(0.065, 0.2, 16),
  pickArrow: new THREE.CylinderGeometry(0.09, 0.09, 1.02, 8),
  pad: new THREE.PlaneGeometry(0.26, 0.26),
  ring: new THREE.TorusGeometry(1, 0.02, 8, 64),
  ringPick: new THREE.TorusGeometry(1, 0.09, 8, 48),
  scaleShaft: new THREE.CylinderGeometry(0.02, 0.02, 0.62, 12),
  tip: new THREE.BoxGeometry(0.12, 0.12, 0.12),
  center: new THREE.BoxGeometry(0.17, 0.17, 0.17),
};

/** 拾取网格共享材质:不可见但可被 raycast(three 的 Raycaster 不看渲染可见性) */
const PICK_MAT = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthTest: false,
  depthWrite: false,
});
PICK_MAT.userData.pick = true;

interface HandleDef {
  part: GizmoPart;
  key: string;
  mat: THREE.MeshBasicMaterial;
  baseColor: string;
  baseOpacity: number;
}

function makeDef(part: GizmoPart, color: string, opacity = 1): HandleDef {
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: part.kind === 'plane' ? THREE.DoubleSide : THREE.FrontSide,
  });
  return { part, key: partKey(part), mat, baseColor: color, baseOpacity: opacity };
}

/** 单个把手网格:挂载时进注册表、写入 userData,卸载时移除 */
function HandleMesh({
  def,
  geometry,
  mat,
  position,
}: {
  def: HandleDef;
  geometry: THREE.BufferGeometry;
  mat?: THREE.Material; // 缺省用 def.mat;拾取网格传 PICK_MAT
  position?: [number, number, number];
}) {
  const ref = useRef<THREE.Mesh>(null);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    m.userData.gizmoPart = def.part;
    m.userData.partKey = def.key;
    gizmoHandles.add(m);
    return () => {
      gizmoHandles.delete(m);
    };
  }, [def]);
  return (
    <mesh ref={ref} geometry={geometry} material={mat ?? def.mat} position={position} renderOrder={999} />
  );
}

const tmpView = new THREE.Vector3();

export function Gizmo() {
  useUi((s) => s.rev); // 任何 command 后重取选中与枢轴
  const mode = useUi((s) => s.gizmoMode);

  const targets = expandToInstances(doc.selection);
  const box = selectionBBox(
    targets.map((n) => ({ transform: n.transform, bbox: doc.assets.get(n.assetId)!.meta.bbox })),
  );

  const pivotRef = useRef(new THREE.Vector3());
  if (box) box.getCenter(pivotRef.current);

  // 每模式一组把手定义;模式切换时重建并释放旧材质
  const defs = useMemo(() => {
    const list: Record<string, HandleDef> = {};
    const add = (d: HandleDef) => (list[d.key] = d);
    if (mode === 'translate') {
      for (const a of [0, 1, 2] as const) {
        add(makeDef({ mode, kind: 'axis', axis: a }, AXIS_COLORS[a]));
        add(makeDef({ mode, kind: 'plane', axis: a }, AXIS_COLORS[a], 0.35));
      }
    } else if (mode === 'rotate') {
      for (const a of [0, 1, 2] as const) add(makeDef({ mode, kind: 'ring', axis: a }, AXIS_COLORS[a]));
    } else {
      for (const a of [0, 1, 2] as const) add(makeDef({ mode, kind: 'axis', axis: a }, AXIS_COLORS[a]));
      add(makeDef({ mode, kind: 'uniform', axis: 0 }, UNIFORM_COLOR));
    }
    return list;
  }, [mode]);
  useEffect(() => {
    return () => {
      for (const d of Object.values(defs)) d.mat.dispose();
    };
  }, [defs]);

  const groupRef = useRef<THREE.Group>(null);

  // 每帧:摆位、屏幕等距、启用态与着色(hover/active 不走 React 状态,直接读 gizmoUiState)
  useFrame(({ camera, size }) => {
    const g = groupRef.current;
    if (!g) return;
    g.position.copy(pivotRef.current);
    g.scale.setScalar(gizmoWorldScale(camera, pivotRef.current, size.height, GIZMO_PX));
    camera.getWorldDirection(tmpView);
    for (const m of gizmoHandles) {
      const part = m.userData.gizmoPart as GizmoPart;
      const disabled =
        part.kind === 'axis'
          ? axisHandleDisabled(part.axis, tmpView)
          : part.kind === 'plane' || part.kind === 'ring'
            ? planeHandleDisabled(part.axis, tmpView)
            : false;
      m.userData.enabled = !disabled; // 交互层的拾取过滤依据(VIEW 边界 5)
      const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial;
      if (mat.userData.pick) continue;
      const def = defs[m.userData.partKey as string];
      if (!def) continue;
      mat.color.set(
        disabled
          ? DISABLED_COLOR
          : m.userData.partKey === gizmoUiState.activeKey
            ? ACTIVE_COLOR
            : m.userData.partKey === gizmoUiState.hoverKey
              ? HOVER_COLOR
              : def.baseColor,
      );
      mat.opacity = disabled ? 0.28 : def.baseOpacity;
    }
  });

  if (!targets.length || !box) return null;
  const k = (kind: GizmoPart['kind'], axis: number) => `${mode}:${kind}:${axis}`;

  return (
    <group ref={groupRef}>
      {mode === 'translate' &&
        ([0, 1, 2] as const).map((a) => (
          <group key={a} rotation={AXIS_ROT[a]}>
            <HandleMesh def={defs[k('axis', a)]} geometry={GEO.shaft} position={[0, 0.5, 0]} />
            <HandleMesh def={defs[k('axis', a)]} geometry={GEO.head} position={[0, 0.95, 0]} />
            <HandleMesh def={defs[k('axis', a)]} geometry={GEO.pickArrow} mat={PICK_MAT} position={[0, 0.55, 0]} />
          </group>
        ))}
      {mode === 'translate' &&
        ([0, 1, 2] as const).map((a) => (
          <group key={`p${a}`} rotation={NORMAL_ROT[a]}>
            <HandleMesh def={defs[k('plane', a)]} geometry={GEO.pad} position={[0.4, 0.4, 0]} />
          </group>
        ))}
      {mode === 'rotate' &&
        ([0, 1, 2] as const).map((a) => (
          <group key={a} rotation={NORMAL_ROT[a]}>
            <HandleMesh def={defs[k('ring', a)]} geometry={GEO.ring} />
            <HandleMesh def={defs[k('ring', a)]} geometry={GEO.ringPick} mat={PICK_MAT} />
          </group>
        ))}
      {mode === 'scale' && (
        <>
          {([0, 1, 2] as const).map((a) => (
            <group key={a} rotation={AXIS_ROT[a]}>
              <HandleMesh def={defs[k('axis', a)]} geometry={GEO.scaleShaft} position={[0, 0.45, 0]} />
              <HandleMesh def={defs[k('axis', a)]} geometry={GEO.tip} position={[0, 0.84, 0]} />
              <HandleMesh def={defs[k('axis', a)]} geometry={GEO.pickArrow} mat={PICK_MAT} position={[0, 0.5, 0]} />
            </group>
          ))}
          <HandleMesh def={defs[k('uniform', 0)]} geometry={GEO.center} />
        </>
      )}
    </group>
  );
}
