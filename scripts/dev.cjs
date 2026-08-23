/**
 * scripts/dev.cjs —— dev 启动包装器
 *
 * 用法（package.json）：npm run dev
 * 作用：自动挑选机器上的新版 Node（>=18）来运行 Vite 开发服务器，
 *       兼容“IDE 绑定了旧版 Node 12”的场景，用户无需改 IDE 配置。
 */

const path = require('path');
const { spawn } = require('child_process');
const { pickNode } = require('./lib-node.cjs');

/** Vite CLI 入口 */
const viteJs = path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');

/** 透传给 vite 的命令行参数（如 --port 3000） */
const args = process.argv.slice(2);

// 用新版 Node 拉起 Vite；stdio 继承让日志/彩色输出直达终端
const child = spawn(pickNode(18), [viteJs, ...args], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..')
});

child.on('exit', (code) => process.exit(code ?? 0));
