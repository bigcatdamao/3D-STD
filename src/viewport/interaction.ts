// 左键交互状态机(VIEW-02/04)。右键 orbit / 中键 pan / 滚轮缩放由 OrbitControls 承担,
// 左键从控件中剥离,由本 hook 全权处理:
//
//   idle ─按下命中对象→ pressObject ─位移≥3px→ draggingObject ─抬起→ commit(一步入栈)
//                        └─抬起(<3px)→ 点选(不入栈)                └─Esc→ cancel(归位,不入栈)
//   idle ─按下空白→ pressEmpty ─位移≥3px→ marquee ─抬起→ 相交即选(锁定静默排除)
//                    └─抬起(<3px)→ 清空选中(Ctrl 按住则保持)
//
// 锁定对象不可点选:raycast 阶段即被剔除 —— 点击会「穿透」到其后方的可选对象,与切片软件一致。

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { InstanceNode } from '../kernel/types';
import { dispatch, doc, meshRegistry, useUi } from '../state/store';
import {
  exceedsDeadzone,
  intersectHorizontalPlane,
  normalizeRect,
  projectBoxToScreenRect,
  rectsOverlap,
} from './math';

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
  | { mode: 'marquee'; startPx: [number, number]; additive: boolean };

const raycaster = new THREE.Raycaster();

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
    if (n && n.kind === 'instance' && n.visible && !n.locked) candidates.push(obj);
  }
  const hits = raycaster.intersectObjects(candidates, false);
  if (!hits.length) return null; // intersectObjects 按距离升序 → hits[0] 即「最上层」(VIEW 边界 1)
  const id = hits[0].object.userData.instanceId as string;
  return { id, point: hits[0].point.clone() };
}

/** 选中集展开为可拖动的实例集合(组 → 其全部后代实例;锁定成员剔除) */
function expandToInstances(ids: Iterable<string>): InstanceNode[] {
  const out = new Map<string, InstanceNode>();
  for (const id of ids) {
    const n = doc.nodes.get(id);
    if (!n) continue;
    const pool = n.kind === 'instance' ? [n.id] : doc.descendants(n.id);
    for (const pid of pool) {
      const p = doc.nodes.get(pid);
      if (p && p.kind === 'instance' && !p.locked) out.set(p.id, p);
    }
  }
  return [...out.values()];
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

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || drag) return; // 左键专属;右/中键归 OrbitControls
      el.setPointerCapture(e.pointerId);
      const px = toLocalPx(e);
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      const hit = pickInstance(camera, toNdc(e));
      interactionState.active = true;
      drag = hit
        ? { mode: 'pressObject', startPx: px, hitId: hit.id, hitPoint: hit.point, additive }
        : { mode: 'pressEmpty', startPx: px, additive };
    };

    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const [x, y] = toLocalPx(e);

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
          if (!n || n.kind !== 'instance' || !n.visible || n.locked) continue; // 锁定静默排除(VIEW 边界 3)
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
      if (drag?.mode === 'draggingObject') {
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
      if (drag?.mode === 'draggingObject') dispatch((doc2) => doc2.cancelInteraction());
      useUi.getState().setMarquee(null);
      drag = null;
      interactionState.active = false;
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [gl, camera, size]);
}
