/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  test: {
    // 默认 node 环境（引擎测试）；UI 测试文件用 // @vitest-environment jsdom 覆盖，
    // 并在文件内 import '../test/setup-dom' 挂载 jest-dom 与导出拦截。
    environment: 'node',
    globals: true,
    // UI 验收测试含大量用户交互等待，繁忙机器上放宽默认 5s 限制
    testTimeout: 30_000,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
