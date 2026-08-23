/**
 * scripts/build.cjs —— 构建包装器
 *
 * 用法（package.json）：npm run build
 * 作用：自动挑选新版 Node（>=18）依次执行：
 *   1. vue-tsc --noEmit   类型检查；
 *   2. vite build         生产构建。
 * 兼容“IDE 绑定了旧版 Node 12”的场景。
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { pickNode } = require('./lib-node.cjs');

const ROOT = path.join(__dirname, '..');
const node = pickNode(18);

/** 顺序执行一个命令；失败即终止 */
function run(label, jsFile, args) {
  console.log(`\n[build] ${label} ...`);
  const r = spawnSync(node, [path.join(ROOT, 'node_modules', ...jsFile), ...args], {
    stdio: 'inherit',
    cwd: ROOT
  });
  if (r.status !== 0) {
    console.error(`[build] ${label} 失败，退出码 ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

// 1) 类型检查（vue-tsc 的 bin 入口）
run('类型检查 vue-tsc', ['vue-tsc', 'bin', 'vue-tsc.js'], ['--noEmit']);
// 2) 生产构建
run('vite build', ['vite', 'bin', 'vite.js'], ['build']);
