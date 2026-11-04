import { defineConfig } from 'vitest/config';

/**
 * vitest.config.ts —— 单元测试配置
 *
 * 只测纯逻辑（utils / api 的纯函数 / store 的 mutation），
 * 不加载 QuickEarth 与地图相关模块（它们依赖浏览器 WebGL/wasm 环境）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 测试间共享模块级缓存，显式清理由各用例自行负责
    restoreMocks: true
  }
});
