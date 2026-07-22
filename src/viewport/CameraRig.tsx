// 相机装备(VIEW-03 + VIEW-02 的右/中键部分)。
// 鼠标映射:左键从 OrbitControls 剥离(LEFT: -1)交给选择系统;右键 orbit、中键 pan、滚轮缩放。
// 透视↔正交切换保持位姿与表观尺寸;预设/聚焦/复位经 camBus 接收 —— 相机操作一律不入栈(C1)。

import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { doc, meshRegistry, onCam, useUi } from '../state/store';
import { fitDistance, fitOrthoZoom, homePose, matchOrthoZoom, presetPose } from './math';

const FOV = 45;

export function CameraRig() {
  const { set, size, gl } = useThree();
  const ortho = useUi((s) => s.ortho);
  const bed = useUi((s) => s.bed);
  const bedMax = Math.max(bed.x, bed.y, bed.z);
  const controls = useRef<OrbitControlsImpl>(null);

  const persp = useMemo(() => {
    const c = new THREE.PerspectiveCamera(FOV, 1, 1, 8000);
    c.up.set(0, 0, 1); // C3 Z-up
    const h = homePose(256);
    c.position.set(...h.position);
    return c;
  }, []);
  const orthoCam = useMemo(() => {
    const c = new THREE.OrthographicCamera(-1, 1, 1, -1, -4000, 8000);
    c.up.set(0, 0, 1);
    return c;
  }, []);

  // 视口尺寸 → 相机参数(边界 6:resize 重算,位姿与选中不变)
  useEffect(() => {
    persp.aspect = size.width / size.height;
    persp.updateProjectionMatrix();
    orthoCam.left = -size.width / 2;
    orthoCam.right = size.width / 2;
    orthoCam.top = size.height / 2;
    orthoCam.bottom = -size.height / 2;
    orthoCam.updateProjectionMatrix();
  }, [size, persp, orthoCam]);

  // 切换/重建控件时的 target 保底:控件每次 change 都记账,重建后回填
  const lastTarget = useRef(new THREE.Vector3(0, 0, 0));

  // 透视 ↔ 正交:同步位姿,换算 zoom 保持表观尺寸。
  // 注意:camera prop 变化会导致 drei 重建 OrbitControls(target 归零),
  // 因此位姿以 lastTarget 为准,在重建完成后(本 effect 晚于该次渲染)回填。
  useEffect(() => {
    const target = lastTarget.current;
    if (ortho) {
      orthoCam.position.copy(persp.position);
      const d = Math.max(persp.position.distanceTo(target), 1);
      orthoCam.zoom = matchOrthoZoom(d, FOV, size.height);
      orthoCam.updateProjectionMatrix();
      set({ camera: orthoCam });
    } else {
      // 回透视:按正交当前 zoom 反解等效距离,消除表观尺寸跳变
      const dir = orthoCam.position.clone().sub(target);
      if (dir.lengthSq() > 1e-6) {
        const d = size.height / (2 * orthoCam.zoom * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
        persp.position.copy(target.clone().add(dir.normalize().multiplyScalar(d)));
      }
      set({ camera: persp });
    }
    // 控件已随 camera prop 重建 → 回填 target
    const ctl = controls.current;
    if (ctl) {
      ctl.target.copy(target);
      ctl.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ortho]);

  // 相机命令:预设 / 聚焦 / 复位(不入栈)
  useEffect(() => {
    return onCam((cmd) => {
      const ctl = controls.current;
      if (!ctl) return;
      const cam = ctl.object as THREE.PerspectiveCamera | THREE.OrthographicCamera;

      const applyPose = (position: [number, number, number], target: [number, number, number]) => {
        cam.position.set(...position);
        ctl.target.set(...target);
        lastTarget.current.set(...target);
        ctl.update();
      };

      if (cmd.kind === 'preset') {
        const p = presetPose(cmd.view, bedMax);
        applyPose(p.position, p.target);
        if (cam instanceof THREE.OrthographicCamera) {
          cam.zoom = fitOrthoZoom(bedMax * 0.72, size.width, size.height);
          cam.updateProjectionMatrix();
        }
        return;
      }
      if (cmd.kind === 'home') {
        const h = homePose(bedMax);
        applyPose(h.position, h.target);
        if (cam instanceof THREE.OrthographicCamera) {
          cam.zoom = fitOrthoZoom(bedMax * 0.72, size.width, size.height);
          cam.updateProjectionMatrix();
        }
        return;
      }
      const box = new THREE.Box3();
      let any = cmd.kind === 'focusBounds';
      if (cmd.kind === 'focusBounds') {
        box.set(new THREE.Vector3(...cmd.min), new THREE.Vector3(...cmd.max));
      } else {
        // F 聚焦:选中集包围盒;无选中 → 全部可见对象;空场景 → 床
        const ids = doc.selection.size
          ? [...doc.selection]
          : [...meshRegistry.keys()].filter((id) => doc.nodes.get(id)?.visible);
        const sub = new THREE.Box3();
        for (const id of ids) {
          const n = doc.nodes.get(id);
          const pool = n?.kind === 'group' ? doc.descendants(id) : [id];
          for (const pid of pool) {
            const obj = meshRegistry.get(pid);
            if (!obj) continue;
            sub.setFromObject(obj);
            box.union(sub);
            any = true;
          }
        }
      }
      if (!any) box.set(new THREE.Vector3(-bed.x / 2, -bed.y / 2, 0), new THREE.Vector3(bed.x / 2, bed.y / 2, 10));
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 5);
      const dir = cam.position.clone().sub(ctl.target).normalize();
      if (cam instanceof THREE.PerspectiveCamera) {
        const d = fitDistance(radius, FOV, size.width / size.height);
        cam.position.copy(center.clone().add(dir.multiplyScalar(d)));
      } else {
        cam.position.copy(center.clone().add(dir.multiplyScalar(radius * 4)));
        cam.zoom = fitOrthoZoom(radius, size.width, size.height);
        cam.updateProjectionMatrix();
      }
      ctl.target.copy(center);
      lastTarget.current.copy(center);
      ctl.update();
    });
  }, [bedMax, bed, size]);

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      onChange={() => {
        if (controls.current) lastTarget.current.copy(controls.current.target);
      }}
      camera={ortho ? orthoCam : persp}
      domElement={gl.domElement}
      target={[0, 0, 0]}
      enableDamping={false}
      // VIEW-02:左键让位给选择系统;右键 orbit;中键 pan;滚轮缩放为控件默认
      mouseButtons={{
        LEFT: -1 as unknown as THREE.MOUSE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE,
      }}
      minDistance={20}
      maxDistance={4000}
    />
  );
}
