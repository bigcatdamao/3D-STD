// 打印床(VIEW-01):Z-up、mm、原点在床面中心(注:切片软件内部原点多在左前角,
// 本产品对外坐标以床中心为原点 —— 与内核 defaultTransform [0,0,0] 落床中心的语义一致,
// 差异与取舍记录于 PRD 注释层)。40mm 主网格 + 10mm 细分 + 边缘尺寸标注 + 成型体积线框。

import { useMemo } from 'react';
import * as THREE from 'three';
import { BedConfig } from '../state/store';

const COLOR_MINOR = '#26262e';
const COLOR_MAJOR = '#3a3a46';
const COLOR_FRAME = '#4a4a58';
const COLOR_PLATE = '#1d1d23';

function gridGeometry(bed: BedConfig): { minor: THREE.BufferGeometry; major: THREE.BufferGeometry } {
  const hx = bed.x / 2;
  const hy = bed.y / 2;
  const minor: number[] = [];
  const major: number[] = [];
  const push = (arr: number[], x0: number, y0: number, x1: number, y1: number) => {
    arr.push(x0, y0, 0, x1, y1, 0);
  };
  for (let x = -hx; x <= hx + 1e-6; x += 10) {
    const isMajor = Math.abs(x % 40) < 1e-6 || Math.abs(Math.abs(x) - hx) < 1e-6;
    push(isMajor ? major : minor, x, -hy, x, hy);
  }
  for (let y = -hy; y <= hy + 1e-6; y += 10) {
    const isMajor = Math.abs(y % 40) < 1e-6 || Math.abs(Math.abs(y) - hy) < 1e-6;
    push(isMajor ? major : minor, -hx, y, hx, y);
  }
  const mk = (a: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
    return g;
  };
  return { minor: mk(minor), major: mk(major) };
}

/** 成型体积线框:床边界向上拉起的 12 条棱 */
function volumeGeometry(bed: BedConfig): THREE.BufferGeometry {
  const hx = bed.x / 2;
  const hy = bed.y / 2;
  const z = bed.z;
  const c = [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ];
  const pts: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = c[i];
    const [x1, y1] = c[(i + 1) % 4];
    pts.push(x0, y0, z, x1, y1, z); // 顶框
    pts.push(x0, y0, 0, x0, y0, z); // 立柱
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** 边缘尺寸标注:canvas 纹理 sprite,零外部字体依赖 */
function makeLabel(text: string): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8b8b98';
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sp.scale.set(44, 11, 1);
  return sp;
}

export function Bed({ bed }: { bed: BedConfig }) {
  const { minor, major } = useMemo(() => gridGeometry(bed), [bed]);
  const volume = useMemo(() => volumeGeometry(bed), [bed]);
  const labelX = useMemo(() => makeLabel(`X ${bed.x} mm`), [bed.x]);
  const labelY = useMemo(() => makeLabel(`Y ${bed.y} mm`), [bed.y]);

  return (
    <group>
      {/* 床板 */}
      <mesh position={[0, 0, -1.51]} receiveShadow>
        <boxGeometry args={[bed.x, bed.y, 3]} />
        <meshStandardMaterial color={COLOR_PLATE} roughness={0.9} />
      </mesh>
      <lineSegments geometry={minor}>
        <lineBasicMaterial color={COLOR_MINOR} />
      </lineSegments>
      <lineSegments geometry={major}>
        <lineBasicMaterial color={COLOR_MAJOR} />
      </lineSegments>
      <lineSegments geometry={volume}>
        <lineBasicMaterial color={COLOR_FRAME} transparent opacity={0.28} />
      </lineSegments>
      {/* 尺寸标注:前缘与右缘 */}
      <primitive object={labelX} position={[0, -bed.y / 2 - 16, 0.5]} />
      <primitive object={labelY} position={[bed.x / 2 + 26, 0, 0.5]} />
      {/* 原点微标 */}
      <mesh position={[0, 0, 0.2]}>
        <circleGeometry args={[2.2, 24]} />
        <meshBasicMaterial color="#5dcaa5" />
      </mesh>
    </group>
  );
}
