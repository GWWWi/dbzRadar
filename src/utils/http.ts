/**
 * utils/http.ts —— 带超时的 fetch 封装
 *
 * 为什么需要：
 *   浏览器原生 fetch 没有超时。网络半开（服务端既不响应也不断开）时
 *   Promise 会一直挂起，表现为：
 *     - 屏状态永久停在“加载中…”；
 *     - App 的“加载中不推进”逻辑让播放永久卡住；
 *     - 用户没有任何失败反馈。
 *   统一在这里加超时，把“挂起”变成可识别的错误，交给上层 UI 提示。
 */

/** 默认超时（毫秒）：雷达拼图单文件约 6MB，10 秒覆盖常规网络 */
export const DEFAULT_FETCH_TIMEOUT_MS = 10000;

/** 请求超时错误：与网络错误区分，便于 UI 给出“请求超时”而非“加载失败” */
export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`请求超时（${timeoutMs}ms）：${url}`);
    this.name = 'FetchTimeoutError';
  }
}

/**
 * 带超时的 fetch。
 *
 * 返回值与原生 fetch 完全一致（仍是 Response），调用方照旧判断
 * `status === 404` / `ok`，不需要改流程。
 *
 * @param url       请求地址
 * @param timeoutMs 超时毫秒数，默认 DEFAULT_FETCH_TIMEOUT_MS
 * @throws FetchTimeoutError 超时；网络错误原样抛出
 */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  // 不依赖 window，便于在 Node 环境下直接测试本函数
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (e) {
    // abort 后 fetch 抛 AbortError，统一转成带 URL/时长的超时错误
    if (controller.signal.aborted) throw new FetchTimeoutError(url, timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
