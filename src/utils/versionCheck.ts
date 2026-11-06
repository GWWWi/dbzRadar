/**
 * utils/versionCheck.ts —— 构建版本变化检测（部署更新后自动刷新）
 *
 * 问题：部署新版本后，浏览器可能仍在用旧的 index.html / JS（强缓存），
 * 用户必须手动硬刷新才能看到新内容。
 *
 * 方案：构建时注入 __APP_VERSION__ 并产出站点根目录的 version.json；
 * 页面运行期间定时拉取 version.json（带时间戳防缓存）与当前版本比较，
 * 不一致则提示并自动刷新。
 *
 * 防死循环：若刷新后仍是旧版本（通常是 nginx 把 index.html 也缓存了），
 * 同一会话内对同一新版本只自动刷新一次，之后改为提示手动 Ctrl+F5。
 *
 * 只在生产构建启用：开发模式有 HMR，不需要也不应自动刷新。
 */

import { ElMessage } from 'element-plus';
// 提示文案统一走 constants/messages
import { VERSION_MSG } from '../constants/messages';
import { fetchWithTimeout } from './http';

/** 检测间隔（毫秒）：5 分钟，兼顾及时性与请求开销 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** 首次检测延迟（毫秒）：避开首屏取数高峰 */
const FIRST_CHECK_DELAY_MS = 10 * 1000;

/** sessionStorage 标记：记录已为哪个新版本自动刷新过（reload 后仍在） */
const RELOAD_FLAG = 'radar:version-reloaded';

/** 当前运行版本（构建时注入；未注入 / 测试环境为空串） */
const CURRENT_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

/** 是否已进入刷新流程（防止并发检测重复 reload） */
let reloading = false;

/**
 * 已提示过“请手动硬刷新”的版本号。
 * 检测每 5 分钟一次且切回前台就查一次，不去重会在会话内反复弹同一条错误。
 */
let warnedVersion = '';

/** 拉取服务器 version.json 中的版本号；失败 / 非 JSON 一律返回 null */
async function fetchServerVersion(): Promise<string | null> {
  try {
    // 时间戳绕过浏览器 / 代理对 version.json 自身的缓存
    const resp = await fetchWithTimeout(`version.json?t=${Date.now()}`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { version?: unknown };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    // 404 / SPA 回落成 index.html（非 JSON）/ 网络错误 → 视为无版本信息，保持现状
    return null;
  }
}

/** 检测一次；发现版本变化时提示并刷新 */
async function checkOnce(): Promise<void> {
  if (reloading) return;
  // 页面在后台时不刷新：避免用户切回来发现状态丢失
  if (document.visibilityState === 'hidden') return;

  const serverVersion = await fetchServerVersion();
  if (!serverVersion || !CURRENT_VERSION || serverVersion === CURRENT_VERSION) return;

  // 已为该版本自动刷新过一次仍不一致 → 多半是 index.html 被缓存，提示手动硬刷新
  if (sessionStorage.getItem(RELOAD_FLAG) === serverVersion) {
    // 同一版本只提示一次：否则每 5 分钟 / 每次切回前台都弹一遍
    if (warnedVersion !== serverVersion) {
      warnedVersion = serverVersion;
      ElMessage.error(VERSION_MSG.stale);
    }
    return;
  }
  sessionStorage.setItem(RELOAD_FLAG, serverVersion);

  reloading = true;
  console.info(
    `[versionCheck] 检测到新版本 ${serverVersion}（当前 ${CURRENT_VERSION}），即将刷新`
  );
  ElMessage.warning(VERSION_MSG.updating);
  // 留 1.5s 让提示可见再刷新
  window.setTimeout(() => window.location.reload(), 1500);
}

/**
 * 启动版本检测（应用入口调用一次）。
 * 生产构建才启用；首次延迟 10s，之后每 5 分钟检查；切回前台时立即检查一次。
 */
export function startVersionCheck(): void {
  if (!import.meta.env.PROD) return;

  window.setTimeout(() => void checkOnce(), FIRST_CHECK_DELAY_MS);
  window.setInterval(() => void checkOnce(), CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkOnce();
  });
  console.info(`[versionCheck] 版本检测已启动，当前构建版本 ${CURRENT_VERSION || '未知'}`);
}
