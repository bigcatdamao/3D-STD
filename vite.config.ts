import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const devApiOrigin = process.env.VITE_DEV_API_ORIGIN?.trim() || 'https://3d-std.851241233.workers.dev';

export default defineConfig({
  plugins: [react()],
  // 本地只运行 Vite 时没有 Worker 路由。开发态把 /api 转发到当前生产 Worker，
  // 让本地候选 UI 能真实验证生成/拆件链路；上传前仍由产品确认卡明确告知用户。
  server: {
    proxy: {
      '/api': {
        target: devApiOrigin,
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
