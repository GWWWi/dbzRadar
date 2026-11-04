/**
 * api/radarCache.ts —— 共享在途任务与 LRU 缓存
 *
 * 从 radarApi 抽出的通用能力，供网格缓存与 RSTM 体数据缓存复用：
 *   1) SharedTask  ：同一文件的并发请求合并为一次下载 + 解析；
 *   2) LruCache<T> ：条数 + 字节双上限的 LRU，避免大网格/体数据吃满内存。
 *
 * ★ 取消语义 ★
 *   每个调用方只取消自己的等待，waiters 归零时才真正 abort 底层请求。
 *   禁止把第一个调用方的 AbortSignal 直接传给共享 fetch（会连累其它屏）。
 */

/** 取消错误：与网络错误区分，UI 据此保留旧画面且不提示“加载失败” */
export function abortError(): DOMException {
  return new DOMException('请求已取消', 'AbortError');
}

/**
 * 共享任务：同一文件的多屏/多产品请求合并为一次下载 + 解析。
 */
export interface SharedTask<T> {
  promise: Promise<T>;
  controller: AbortController;
  /** 仍在等待结果的调用方数量 */
  waiters: number;
  /** 任务已完成（成功或失败）：此后不再因取消而 abort */
  settled: boolean;
}

/** 创建一个共享任务；run 接收任务级 signal（只在所有等待者都取消时 abort） */
export function createSharedTask<T>(run: (signal: AbortSignal) => Promise<T>): SharedTask<T> {
  const controller = new AbortController();
  let task!: SharedTask<T>;
  const promise = run(controller.signal).finally(() => {
    task.settled = true;
  });
  task = { promise, controller, waiters: 0, settled: false };
  return task;
}

/**
 * 等待共享任务；signal 取消只影响本次等待，不影响其它屏。
 *
 * 没有 signal 时直接复用任务；有 signal 时把“调用方取消”与“共享任务失败”
 * 分开处理：前者 reject AbortError，后者原样透传。
 */
export function joinSharedTask<T>(task: SharedTask<T>, signal?: AbortSignal): Promise<T> {
  task.waiters++;
  if (!signal) {
    return task.promise.finally(() => releaseSharedTask(task));
  }
  if (signal.aborted) {
    releaseSharedTask(task);
    // 任务可能稍后才失败；挂一个空 catch 避免 unhandled rejection
    task.promise.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (action: () => void): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      releaseSharedTask(task);
      action();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    task.promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

/** 一个等待者离开；最后一个离开且任务未完成时中止底层请求 */
function releaseSharedTask<T>(task: SharedTask<T>): void {
  task.waiters = Math.max(0, task.waiters - 1);
  if (!task.settled && task.waiters === 0) task.controller.abort();
}

/** LRU 缓存配置 */
export interface LruCacheOptions<T> {
  /** 条数上限（至少 1） */
  maxEntries: number;
  /** 总字节预算（至少保留 1 条） */
  maxBytes: number;
  /** 估算单条缓存值占用的字节数 */
  estimate: (value: T) => number;
}

/**
 * 条数 + 字节双上限的 LRU 缓存。
 *
 * 读取命中会把条目移到 Map 末尾（最近使用），写入按条数/字节预算淘汰队首。
 * 字节预算至少保留 1 条：单条超大网格不能刚写入就被自己挤掉。
 */
export class LruCache<T> {
  private readonly items = new Map<string, T>();
  /** key → 估算字节数（与 items 同步维护） */
  private readonly sizes = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly estimate: (value: T) => number;

  constructor(options: LruCacheOptions<T>) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxBytes = Math.max(1, options.maxBytes);
    this.estimate = options.estimate;
  }

  /** 当前缓存条数 */
  get size(): number {
    return this.items.size;
  }

  /** 读缓存；命中后移到末尾，维护“最近使用序” */
  get(key: string): T | undefined {
    const hit = this.items.get(key);
    if (hit === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, hit);
    return hit;
  }

  /** 写入缓存，并按条数/字节预算淘汰最久未使用的条目 */
  set(key: string, value: T): void {
    this.items.delete(key);
    this.items.set(key, value);
    this.sizes.delete(key);
    this.sizes.set(key, this.estimate(value));

    while (this.items.size > this.maxEntries) this.evictOldest();

    let totalBytes = 0;
    for (const bytes of this.sizes.values()) totalBytes += bytes;
    while (totalBytes > this.maxBytes && this.items.size > 1) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      totalBytes -= this.sizes.get(oldest) ?? 0;
      this.items.delete(oldest);
      this.sizes.delete(oldest);
    }
  }

  /** 清空缓存 */
  clear(): void {
    this.items.clear();
    this.sizes.clear();
  }

  /** 淘汰最久未用的一条（条数与字节预算共用） */
  private evictOldest(): void {
    const oldest = this.items.keys().next().value;
    if (oldest === undefined) return;
    this.items.delete(oldest);
    this.sizes.delete(oldest);
  }
}
