import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 构建版本号（yyyyMMddHHmmss）。
 *
 * 用途：注入前端常量 __APP_VERSION__，并在 build 时产出 dist/version.json。
 * 前端定时拉取 version.json 与运行中的版本比较，发现更新即自动刷新，
 * 避免部署后用户仍停留在旧 index.html / 旧 JS（必须硬刷新才能看到新内容）。
 */
const BUILD_VERSION = (() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
})();

/** 产出 dist/version.json（内容与构建时注入的 __APP_VERSION__ 一致，供前端轮询比对） */
function versionFilePlugin(): Plugin {
  return {
    name: 'emit-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: BUILD_VERSION })
      });
    }
  };
}

/**
 * vite.config.ts —— Vite 构建配置
 *
 * 要点：
 *  - public/ 下的内容会原样拷贝到产物根目录，因此我们把
 *      · QE 运行资源放在 public/libs/wasm、public/libs/workers
 *      · 雷达测试数据放在 public/data
 *    运行时通过绝对路径 /libs/... /data/... 访问。
 *
 *  - compressjs 仅在 Node 端（scripts/prepare-data.cjs）用于 bz2 解压，
 *    不进入浏览器依赖图（其内部 amdefine 与打包器互操作差，
 *    会导致运行时 "Cannot read properties of undefined (reading 'apply')" 白屏崩溃）。
 */
export default defineConfig({
  define: {
    // 前端代码中的 __APP_VERSION__ 会被替换为该字面量（dev / build 都注入）
    __APP_VERSION__: JSON.stringify(BUILD_VERSION)
  },
  plugins: [vue(), versionFilePlugin()],
  server: {
    port: 5179,
    // host: true → 监听 0.0.0.0（含局域网网卡），可经本机 IP 访问；
    // 启动日志里的 Network 地址即为可用地址（如 http://192.168.1.20:5179/）。
    // 仅监听 localhost 时，同一局域网的其它设备无法连接。
    host: true,
    proxy: {
      // 雷达数据服务反向代理：9099 是静态文件服务且未返回 CORS 头，
      // 浏览器直接 fetch 绝对地址会被跨域拦截，这里转发为同源路径。
      // 前端取数基地址见 src/config/dataSource.ts（/radar-data/）。
      '/radar-data': {
        target: 'http://localhost:9099',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/radar-data/, '/data/radarData')
      }
    }
  },
  // 预览构建产物时同样允许局域网访问（npm run preview）
  preview: {
    port: 4173,
    host: true
  },
  build: {
    outDir: 'dist',
    // 单文件超过 1500KB 时不再警告（雷达数据体量较大）
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // vendor 分包：业务代码改动时 vue / element-plus / QE 仍可命中浏览器缓存。
        // 只改变文件切分，不改变首屏总字节数。
        manualChunks: {
          vue: ['vue'],
          'element-plus': ['element-plus'],
          quickearth: ['@quickearth/core', '@quickearth/leaflet']
        }
      }
    }
  }
});
