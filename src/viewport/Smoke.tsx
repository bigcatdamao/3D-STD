// T1 冒烟视口:验证 Z-up 世界(C3)与部署链路。T5 将替换为完整世界/相机/选择系统。
import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';

const BED = 256; // VIEW-01 预设:Bambu 256 机型;T5 做成可配置

export function Smoke() {
  return (
    <Canvas
      camera={{ position: [280, -280, 220], up: [0, 0, 1], fov: 45, near: 1, far: 5000 }}
      style={{ background: '#141417' }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[200, -150, 300]} intensity={1.2} />
      {/* 打印床:XY 平面为地面,Z 为高度(C3 Z-up) */}
      <mesh position={[0, 0, -1.01]}>
        <boxGeometry args={[BED, BED, 2]} />
        <meshStandardMaterial color="#232329" />
      </mesh>
      <gridHelper args={[BED, 16, '#3a3a44', '#2a2a32']} rotation-x={Math.PI / 2} />
      {/* 一个坐在床面上的立方体:若它「立」在网格上而非穿插,Z-up 配置即正确 */}
      <mesh position={[0, 0, 15]}>
        <boxGeometry args={[30, 30, 30]} />
        <meshStandardMaterial color="#5dcaa5" />
      </mesh>
      <OrbitControls makeDefault target={[0, 0, 0]} />
    </Canvas>
  );
}
