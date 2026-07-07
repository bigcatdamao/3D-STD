// 左键交互状态机(VIEW-02/04/05)。右键 orbit / 中键 pan / 滚轮缩放由 OrbitControls 承担,
// 左键从控件中剥离,由本 hook 全权处理。T6 起 gizmo 把手拾取优先于对象拾取:
//
//   idle ─按下命中把手→ pressGizmo ─位移≥3px→ draggingGizmo ─抬起→ commit(一步入栈)
//                        └─抬起(<3px)→ 无操作                    └─Esc→ cancel(归位,不入栈)
//   idle ─按下命中对象→ pressObject ─位移≥3px→ draggingObject ─抬起→ commit(一步入栈)
//                        └─抬起(<3px)→ 点选(不入栈)              └─Esc→ cancel(归位,不入栈)
//   idle ─按下空白→ pressEmpty ─位移≥3px→ marquee ─抬起→ 相交即选(锁定静默排除)
//                    └─抬起(<3px)→ 清空选中(Ctrl 按住则保持)
//
// 锁定对象不可点选:raycast 阶段即被剔除 —— 点击会「穿透」到其后方的可选对象,与切片软件一致。
// gizmo 拖拽期间 Ctrl = 吸附(1mm/5°/5%,VIEW-05),增量经浮标(useUi.hud)实时外显。

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { normalizeDeg } from '../kernel/scene';
import { Vec3 } from '../kernel/types';
import {
  dispatch,
  doc,
  expandToInstances,
  gizmoHandles,
  gizmoUiState,
  meshRegistry,
  useUi,
} from '../state/store';
import {
  AXIS_UNIT,
  GizmoPart,
  angleOnPlaneDeg,
  axisScaleFactor,
  closestParamOnAxis,
  fmtSigned,
  intersectAxisPlane,
  partKey,
  ROTATE_SNAP_DEG,
  selectionBBox,
  shortestDeltaDeg,
  snapValue,
  TRANSLATE_SNAP_MM,
  uniformScaleFactor,
} from './gizmo-math';
import {
  exceedsDeadzone,
  intersectHorizontalPlane,
  normalizeRect,
  projectBoxToScreenRect,
  rectsOverlap,
} from './math';

/** gizmo 拖拽起点测量(按把手类型取其一) */
interface GizmoRef {
  s0?: number; // 轴把手:抓取点在轴上的参数
  hit0?: THREE.Vector3; // 平面块:起始交点
  a0?: number; // 旋转环:起始方位角(度)
  d0?: number; // 整体缩放:起始屏幕距离(px)
  pivotPx?: [number, number];
}

interface GizmoTarget {
  id: string;
  startPos: Vec3;
  startRot: Vec3;
  startScale: Vec3;
}

type Drag =
  | { mode: 'pressObject'; startPx: [number, number]; hitId: string; hitPoint: THREE.Vector3; additive: boolean }
  | {
      mode: 'draggingObject';
      startPx: [number, number];
      planeZ: number;
      startPoint: THREE.Vector3;
      targets: { id: string; startPos: [number, number, number] }[];
    }
  | { mode: 'pressEmpty'; startPx: [number, number]; additive: boolean }
  | { mode: 'marquee'; startPx: [number, number]; additive: boolean }
  | { mode: 'pressGizmo'; startPx: [number, number]; part: GizmoPart; pivot: THREE.Vector3; ref: GizmoRef }
  | {
      mode: 'draggingGizmo';
      part: GizmoPart;
      pivot: THREE.Vector3;
      ref: GizmoRef;
      targets: GizmoTarget[];
      rotAccum: number;
      lastAngle: number;
    };

const raycaster = new THREE.Raycaster();
const AXIS_NAME = 'XYZ';
/** 平面块法线轴 → 面内两轴 */
const PLANE_AXES: readonly (readonly [0 | 1 | 2, 0 | 1 | 2])[] = [
  [1, 2],
  [0, 2],
  [0, 1],
];

/** 供视口层查询:Esc 语义分流(拖动中 = 取消拖动;空闲 = 清空选中) */
export const interactionState = { active: false };

function pickInstance(
  camera: THREE.Camera,
  ndc: THREE.Vector2,
): { id: string; point: THREE.Vector3 } | null {
  raycaster.setFromCamera(ndc, camera);
  // 只对可选 mesh 求交:锁定/隐藏对象在候选集合之外(VIEW-04)
  const candidates: THREE.Object3D[] = [];
  for (const [id, obj] of meshRegistry) {
    const n = doc.nodes.get(id);
    if (n && n.kind === 'instance' && doc.effectiveVisible(id) && !doc.effectiveLocked(id)) candidates.push(obj);
  }
  const hits = raycaster.intersectObjects(candidates, false);
  if (!hits.length) return null; // intersectObjects 按距离升序 → hits[0] 即「最上层」(VIEW 边界 1)
  const id = hits[0].object.userData.instanceId as string;
  return { id, point: hits[0].point.clone() };
}

/** gizmo 把手拾取:启用的把手优先于场景对象(标准 gizmo 行为);禁用把手不参与(VIEW 边界 5) */
function pickGizmoPart(camera: THREE.Camera, ndc: THREE.Vector2): GizmoPart | null {
  if (!gizmoHandles.size) return null;
  raycaster.setFromCamera(ndc, camera);
  const candidates = [...gizmoHandles].filter((m) => m.userData.enabled !== false);
  const hits = raycaster.intersectObjects(candidates, false);
  return hits.length ? (hits[0].object.userData.gizmoPart as GizmoPart) : null;
}

/** 当前 gizmo 枢轴 = 选中集(展开后)世界包围盒中心;由文档数据推导,不依赖渲染帧 */
function currentGizmoPivot(): THREE.Vector3 | null {
  const targets = expandToInstances(doc.selection);
  if (!targets.length) return null;
  const box = selectionBBox(
    targets.map((n) => ({ transform: n.transform, bbox: doc.assets.get(n.assetId)!.meta.bbox })),
  );
  return box ? box.getCenter(new THREE.Vector3()) : null;
}

export function useViewportInteraction() {
  const { gl, camera, size } = useThree();

  useEffect(() => {
    const el = gl.domElement;
    let drag: Drag | null = null;

    const toNdc = (e: PointerEvent): THREE.Vector2 => {
      const r = el.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
    };
    const toLocalPx = (e: PointerEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const pivotToPx = (pivot: THREE.Vector3): [number, number] => {
      const v = pivot.clone().project(camera);
      return [((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height];
    };

    /** 按把手类型做起始测量;raycaster 已由 pickGizmoPart 设好 */
    const gizmoRefAt = (part: GizmoPart, pivot: THREE.Vector3, px: [number, number]): GizmoRef | null => {
      if (part.kind === 'axis') {
        const s0 = closestParamOnAxis(raycaster.ray, pivot, AXIS_UNIT[part.axis]);
        return s0 == null ? null : { s0 };
      }
      if (part.kind === 'plane') {
        const hit0 = intersectAxisPlane(raycaster.ray, pivot, part.axis);
        return hit0 ? { hit0: hit0.clone() } : null;
      }
      if (part.kind === 'ring') {
        const a0 = angleOnPlaneDeg(raycaster.ray, pivot, part.axis);
        return a0 == null ? null : { a0 };
      }
      const pivotPx = pivotToPx(pivot);
      const d0 = Math.max(Math.hypot(px[0] - pivotPx[0], px[1] - pivotPx[1]), 2);
      return { d0, pivotPx };
    };

    const clearGizmoFeedback = () => {
      gizmoUiState.activeKey = null;
      useUi.getState().setHud(null);
    };

    /** draggingGizmo 每帧应用:纯数学在 gizmo-math,此处只做「测量 → 吸附 → 派发 → 浮标」 */
    const moveGizmo = (e: PointerEvent, dd: Extract<Drag, { mode: 'draggingGizmo' }>) => {
      raycaster.setFromCamera(toNdc(e), camera);
      const snap = e.ctrlKey || e.metaKey;
      const [px, py] = toLocalPx(e);
      const { part } = dd;
      let hud = '';

      if (part.mode === 'translate' && part.kind === 'axis') {
        const s1 = closestParamOnAxis(raycaster.ray, dd.pivot, AXIS_UNIT[part.axis]);
        if (s1 == null || dd.ref.s0 == null) return;
        let dv = s1 - dd.ref.s0;
        if (snap) dv = snapValue(dv, TRANSLATE_SNAP_MM);
        dispatch((d) =>
          d.updateInteraction(() => {
            for (const t of dd.targets) {
              const p = [...t.startPos] as Vec3;
              p[part.axis] += dv;
              doc.instance(t.id).transform.position = p;
            }
          }),
        );
        hud = `Δ${AXIS_NAME[part.axis]} ${fmtSigned(dv)} mm`;
      } else if (part.mode === 'translate' && part.kind === 'plane') {
        const hit1 = intersectAxisPlane(raycaster.ray, dd.pivot, part.axis);
        if (!hit1 || !dd.ref.hit0) return;
        const [i, j] = PLANE_AXES[part.axis];
        const dvRaw = hit1.sub(dd.ref.hit0);
        const comps: [number, number] = [dvRaw.getComponent(i), dvRaw.getComponent(j)];
        if (snap) {
          comps[0] = snapValue(comps[0], TRANSLATE_SNAP_MM);
          comps[1] = snapValue(comps[1], TRANSLATE_SNAP_MM);
        }
        dispatch((d) =>
          d.updateInteraction(() => {
            for (const t of dd.targets) {
              const p = [...t.startPos] as Vec3;
              p[i] += comps[0];
              p[j] += comps[1];
              doc.instance(t.id).transform.position = p;
            }
          }),
        );
        hud = `Δ${AXIS_NAME[i]} ${fmtSigned(comps[0])} · Δ${AXIS_NAME[j]} ${fmtSigned(comps[1])} mm`;
      } else if (part.mode === 'rotate') {
        const a1 = angleOnPlaneDeg(raycaster.ray, dd.pivot, part.axis);
        if (a1 == null) return;
        dd.rotAccum += shortestDeltaDeg(dd.lastAngle, a1); // 跨 ±180 连续累加
        dd.lastAngle = a1;
        const ang = snap ? snapValue(dd.rotAccum, ROTATE_SNAP_DEG) : dd.rotAccum;
        dispatch((d) =>
          d.updateInteraction(() => {
            for (const t of dd.targets) {
              const r = [...t.startRot] as Vec3;
              r[part.axis] += ang; // 欧拉分量通道(C6,见 gizmo-math 头注);归一在 commit 时统一做
              doc.instance(t.id).transform.rotation = r;
            }
          }),
        );
        hud = `R${AXIS_NAME[part.axis]} ${fmtSigned(ang)}°`;
      } else if (part.mode === 'scale' && part.kind === 'axis') {
        const s1 = closestParamOnAxis(raycaster.ray, dd.pivot, AXIS_UNIT[part.axis]);
        if (s1 == null || dd.ref.s0 == null) return;
        const f = axisScaleFactor(dd.ref.s0, s1, snap);
        dispatch((d) =>
          d.updateInteraction(() => {
            for (const t of dd.targets) {
              const s = [...t.startScale] as Vec3;
              s[part.axis] *= f;
              doc.instance(t.id).transform.scale = s;
            }
          }),
        );
        hud = `${AXIS_NAME[part.axis]} ×${f.toFixed(2)}`;
      } else {
        // scale · uniform:光标到枢轴屏幕距离之比
        if (dd.ref.d0 == null || !dd.ref.pivotPx) return;
        const d1 = Math.hypot(px - dd.ref.pivotPx[0], py - dd.ref.pivotPx[1]);
        const f = uniformScaleFactor(dd.ref.d0, d1, snap);
        dispatch((d) =>
          d.updateInteraction(() => {
            for (const t of dd.targets) {
              doc.instance(t.id).transform.scale = [
                t.startScale[0] * f,
                t.startScale[1] * f,
                t.startScale[2] * f,
              ];
            }
          }),
        );
        hud = `×${f.toFixed(2)}(${Math.round(f * 100)}%)`;
      }
      if (hud) useUi.getState().setHud({ text: hud, x: px, y: py });
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || drag) return; // 左键专属;右/中键归 OrbitControls
      const px = toLocalPx(e);
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;

      // 1) gizmo 把手优先(仅启用把手参与拾取)
      const part = pickGizmoPart(camera, toNdc(e));
      if (part) {
        const pivot = currentGizmoPivot();
        const ref = pivot ? gizmoRefAt(part, pivot, px) : null;
        if (pivot && ref) {
          el.setPointerCapture(e.pointerId);
          interactionState.active = true;
          drag = { mode: 'pressGizmo', startPx: px, part, pivot, ref };
          return;
        }
      }

      // 2) 对象 / 空白
      el.setPointerCapture(e.pointerId);
      const hit = pickInstance(camera, toNdc(e));
      interactionState.active = true;
      drag = hit
        ? { mode: 'pressObject', startPx: px, hitId: hit.id, hitPoint: hit.point, additive }
        : { mode: 'pressEmpty', startPx: px, additive };
    };

    const onMove = (e: PointerEvent) => {
      if (!drag) {
        // 空闲态:hover 预高亮把手 + 指针样式
        const part = pickGizmoPart(camera, toNdc(e));
        const key = part ? partKey(part) : null;
        if (gizmoUiState.hoverKey !== key) {
          gizmoUiState.hoverKey = key;
          el.style.cursor = part ? 'pointer' : '';
        }
        return;
      }
      const [x, y] = toLocalPx(e);

      if (drag.mode === 'pressGizmo') {
        const dp = drag;
        if (!exceedsDeadzone(dp.startPx[0], dp.startPx[1], x, y)) return;
        const insts = expandToInstances(doc.selection);
        if (!insts.length) {
          drag = null;
          interactionState.active = false;
          return;
        }
        const targets: GizmoTarget[] = insts.map((n) => ({
          id: n.id,
          startPos: [...n.transform.position] as Vec3,
          startRot: [...n.transform.rotation] as Vec3,
          startScale: [...n.transform.scale] as Vec3,
        }));
        const verb = dp.part.mode === 'translate' ? '移动' : dp.part.mode === 'rotate' ? '旋转' : '缩放';
        doc.beginInteraction(`${verb} ${targets.length} 个对象`, targets.map((t) => t.id));
        gizmoUiState.activeKey = partKey(dp.part);
        drag = {
          mode: 'draggingGizmo',
          part: dp.part,
          pivot: dp.pivot,
          ref: dp.ref,
          targets,
          rotAccum: 0,
          lastAngle: dp.ref.a0 ?? 0,
        };
        moveGizmo(e, drag); // 越过死区的这一帧立即生效
        return;
      }

      if (drag.mode === 'draggingGizmo') {
        moveGizmo(e, drag);
        return;
      }

      if (drag.mode === 'pressObject') {
        const dp = drag;
        if (!exceedsDeadzone(dp.startPx[0], dp.startPx[1], x, y)) return;
        // 越过死区 → 进入拖动。若命中对象不在选中集内,先替换选中(选中变更不入栈,C1 第三类)
        if (!doc.selection.has(dp.hitId)) dispatch((d) => d.select([dp.hitId]));
        const targets = expandToInstances(doc.selection).map((n) => ({
          id: n.id,
          startPos: [...n.transform.position] as [number, number, number],
        }));
        if (!targets.length) {
          drag = null;
          return;
        }
        doc.beginInteraction(`移动 ${targets.length} 个对象`, targets.map((t) => t.id));
        drag = {
          mode: 'draggingObject',
          startPx: drag.startPx,
          planeZ: drag.hitPoint.z, // 拖拽面:过命中点的水平面,Z 不变(切片软件语义)
          startPoint: drag.hitPoint,
          targets,
        };
        return;
      }

      if (drag.mode === 'draggingObject') {
        const dd = drag;
        raycaster.setFromCamera(toNdc(e), camera);
        const now = intersectHorizontalPlane(raycaster.ray, dd.planeZ);
        if (!now) return;
        const dx = now.x - dd.startPoint.x;
        const dy = now.y - dd.startPoint.y;
        dispatch((d) =>
          d.updateInteraction(() => {
            for (const t of dd.targets) {
              const inst = doc.instance(t.id);
              inst.transform.position = [t.startPos[0] + dx, t.startPos[1] + dy, t.startPos[2]];
            }
          }),
        );
        return;
      }

      if (drag.mode === 'pressEmpty') {
        if (!exceedsDeadzone(drag.startPx[0], drag.startPx[1], x, y)) return;
        drag = { mode: 'marquee', startPx: drag.startPx, additive: drag.additive };
      }
      if (drag.mode === 'marquee') {
        useUi.getState().setMarquee({ x0: drag.startPx[0], y0: drag.startPx[1], x1: x, y1: y });
      }
    };

    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !drag) return;
      const d = drag;
      drag = null;
      interactionState.active = false;
      el.releasePointerCapture?.(e.pointerId);

      if (d.mode === 'draggingGizmo') {
        if (d.part.mode === 'rotate') {
          // PANEL-05 旋转归一到 (-180,180]:并入本次交互,不产生额外记录
          dispatch((doc2) =>
            doc2.updateInteraction(() => {
              for (const t of d.targets) {
                const r = doc.instance(t.id).transform.rotation;
                doc.instance(t.id).transform.rotation = [
                  normalizeDeg(r[0]),
                  normalizeDeg(r[1]),
                  normalizeDeg(r[2]),
                ];
              }
            }),
          );
        }
        dispatch((doc2) => doc2.commitInteraction()); // 整段拖拽 = 一步(C1 第二类)
        clearGizmoFeedback();
        return;
      }
      if (d.mode === 'pressGizmo') {
        return; // 把手上点一下不拖:无操作、无历史
      }
      if (d.mode === 'draggingObject') {
        dispatch((doc2) => doc2.commitInteraction()); // 整段拖动 = 一步(C1 第二类)
        return;
      }
      if (d.mode === 'pressObject') {
        // <3px:点选,不入栈(验收样例 1)
        dispatch((doc2) => {
          if (d.additive) {
            const next = new Set(doc2.selection);
            next.has(d.hitId) ? next.delete(d.hitId) : next.add(d.hitId);
            doc2.select([...next]);
          } else {
            doc2.select([d.hitId]);
          }
        });
        return;
      }
      if (d.mode === 'marquee') {
        const m = useUi.getState().marquee;
        useUi.getState().setMarquee(null);
        if (!m) return;
        const rect = normalizeRect(m.x0, m.y0, m.x1, m.y1);
        const picked: string[] = [];
        const box = new THREE.Box3();
        for (const [id, obj] of meshRegistry) {
          const n = doc.nodes.get(id);
          if (!n || n.kind !== 'instance' || !doc.effectiveVisible(id) || doc.effectiveLocked(id)) continue; // 锁定(含随组锁定)静默排除(VIEW 边界 3 / C7)
          box.setFromObject(obj);
          const sr = projectBoxToScreenRect(box, camera, size.width, size.height);
          if (sr && rectsOverlap(rect, sr)) picked.push(id); // 相交即选(VIEW-04)
        }
        dispatch((doc2) => {
          const base = d.additive ? [...doc2.selection] : [];
          doc2.select([...new Set([...base, ...picked])]);
        });
        return;
      }
      // pressEmpty + <3px:空白点选 → 清空(Ctrl 按住则保持现状)
      if (!d.additive) dispatch((doc2) => doc2.select([]));
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (drag?.mode === 'draggingGizmo') {
        dispatch((doc2) => doc2.cancelInteraction()); // 归位、不入栈(VIEW 边界 4)
        clearGizmoFeedback();
        drag = null;
        interactionState.active = false;
      } else if (drag?.mode === 'pressGizmo') {
        drag = null;
        interactionState.active = false;
      } else if (drag?.mode === 'draggingObject') {
        dispatch((doc2) => doc2.cancelInteraction()); // 归位、不入栈(VIEW 边界 4)
        drag = null;
        interactionState.active = false;
      } else if (drag?.mode === 'marquee') {
        useUi.getState().setMarquee(null);
        drag = null;
        interactionState.active = false;
      }
    };

    const onCancel = () => {
      // 指针异常终止(如窗口失焦):按取消处理,宁可丢一次拖动也不留半步入栈
      if (drag?.mode === 'draggingObject' || drag?.mode === 'draggingGizmo') {
        dispatch((doc2) => doc2.cancelInteraction());
      }
      clearGizmoFeedback();
      useUi.getState().setMarquee(null);
      drag = null;
      interactionState.active = false;
    };

    const onLeave = () => {
      if (drag) return; // 拖拽中已 setPointerCapture,离开画布不算 leave
      gizmoUiState.hoverKey = null;
      el.style.cursor = '';
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('pointerleave', onLeave);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKey);
    };
  }, [gl, camera, size]);
}
