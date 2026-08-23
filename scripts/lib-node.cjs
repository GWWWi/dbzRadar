/**
 * scripts/lib-node.cjs —— 公共工具：挑选可用的 Node 可执行文件
 *
 * 背景：本机存在多套 Node 安装（如 C:\Program Files\nodejs 为 v12，
 * C:\nvm4w\nodejs 为 v22）。Vite 5 要求 Node >= 18。
 * 当用户用旧版 Node 的 npm 启动脚本时，这里负责找到新版 node.exe：
 *   1. 当前进程的 node 已 >= 18 → 直接用 process.execPath；
 *   2. 否则按候选路径逐个探测版本，返回第一个满足要求的；
 *   3. 全部不可用则打印提示并退出。
 */

const fs = require('fs');
const { spawnSync } = require('child_process');

/** 新版 Node 的候选安装路径（按优先级） */
const CANDIDATES = [
  'C:\\nvm4w\\nodejs\\node.exe',
  'C:\\Program Files\\nodejs\\node.exe'
];

/** 读取某个 node 可执行文件的主版本号；失败返回 -1 */
function nodeMajor(execPath) {
  try {
    const r = spawnSync(execPath, ['-v'], { encoding: 'utf-8' });
    if (r.status !== 0) return -1;
    const m = String(r.stdout || '').trim().match(/^v(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

/**
 * 返回一个满足 >= minMajor 的 node 可执行文件绝对路径。
 * @param {number} [minMajor=18] 最低主版本要求
 */
function pickNode(minMajor = 18) {
  // 1) 当前 node 满足要求 → 用自己
  const selfMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (selfMajor >= minMajor) return process.execPath;

  // 2) 探测候选路径
  for (const p of CANDIDATES) {
    if (!fs.existsSync(p)) continue;
    if (p === process.execPath) continue; // 就是当前这个旧 node，跳过
    if (nodeMajor(p) >= minMajor) return p;
  }

  console.error(
    `[runner] 未找到 Node >= ${minMajor}。Vite 5 需要较新的 Node。\n` +
    '请安装或切换后重试（例如：nvm install 22 && nvm use 22）。'
  );
  process.exit(1);
}

module.exports = { pickNode };
