/**
 * api/radarApi.ts —— 雷达取数对外门面（缓存编排 + 兼容导出）
 *
 * 具体职责已拆分到三个模块：
 *   - radarManifest：清单发现（配置 / manifest / 目录扫描 / 本地回退）、模板地址、resolveDataUrl；
 *   - radarSource  ：下载 + bz2 解压 + 格式识别 + 分派解析器、用户上传文件解析；
 *   - radarCache   ：共享在途任务（引用计数取消）与条数/字节双上限 LRU。
 *
 * 本文件只负责 fetchRadarGrid / fetchRstmVolume 的缓存编排，并 re-export
 * 原有公开 API，调用方的 `import ... from '../api/radarApi'` 无需改动。
 *
 * ★ 取数缓存 ★
 *   - 网格：LRU 12 条 / 160MB，键 = binFile|productId（解析结果依赖产品）；
 *   - 体数据：LRU 3 份 / 384MB，键 = binFile；非体数据记入负缓存，避免重复试解析；
 *   - 同一键的并发请求合并为一个共享任务；调用方取消只影响自己的等待。
 *
 * ★ 返回对象共享 ★
 *   多屏/播放会复用同一格网与体数据对象，调用方必须只读：
 *   渲染层在副本上过滤弱值，取值函数只读。
 */

import type { RadarFileMeta, RadarGrid, RstmVolume } from '../types';
import { abortError, createSharedTask, joinSharedTask, LruCache } from './radarCache';
import type { SharedTask } from './radarCache';
import { clearFallbackBuffers, loadGrid, loadVolume } from './radarSource';

// —— 兼容导出：调用方继续从 radarApi 导入 ——
export { RadarFileMissingError, parseUploadedFile } from './radarSource';
export { buildFileMetaFromTemplate, fetchRadarFileList } from './radarManifest';

/* ───────────────────────── 网格缓存 ───────────────────────── */

/**
 * 已解析网格的 LRU 缓存。
 *
 * 目的：播放（800ms 一档）与时间轴来回拖动会反复请求同一时次。
 * 没有缓存时每次都要重新下载并解析 168 万点，主线程会被解析占满。
 */
const gridCache = new LruCache<RadarGrid>({
  maxEntries: 12,
  // 正常 12 条 SWAN 网格约 80MB；预算兜底 RSTM 栅格化 / 超大网格
  maxBytes: 160 * 1024 * 1024,
  estimate: (grid) => grid.data.byteLength + 1024
});

/** 在途请求合并表：多屏同步时同一文件只下载 + 解析一次 */
const pendingGrids = new Map<string, SharedTask<RadarGrid>>();

/** 缓存键：文件名 + 产品（模板模式与清单模式对同一文件共用缓存） */
function cacheKey(meta: RadarFileMeta, productId: string): string {
  return meta.binFile + '|' + productId;
}

/**
 * 获取某个文件、某个产品对应的雷达网格（核心取数方法，带缓存与并发合并）。
 *
 * 三条路径：
 *   1. 缓存命中 → 直接返回（播放回退、多屏共享同一对象，零解析成本）；
 *   2. 同键请求在途 → 复用共享任务（4 屏同步只下载 + 解析一次），
 *      各调用方的 AbortSignal 只取消自己的等待，不会连累其它屏；
 *   3. 否则 → 执行 loadGrid，成功后写入缓存。
 *
 * @param meta      文件清单项
 * @param productId 产品代码，决定单位与兜底峰值
 * @param signal    取消信号（切换时次/组件卸载时 abort）
 * @returns 解析后的网格；404 抛 RadarFileMissingError，其余错误原样抛出
 */
export async function fetchRadarGrid(
  meta: RadarFileMeta,
  productId: string,
  signal?: AbortSignal
): Promise<RadarGrid> {
  const key = cacheKey(meta, productId);

  const cached = gridCache.get(key);
  if (cached) {
    if (signal?.aborted) throw abortError();
    return cached;
  }

  // 同键请求在途：复用同一个共享任务；调用方取消只影响自己的等待
  let task = pendingGrids.get(key);
  if (!task) {
    task = createSharedTask((taskSignal) =>
      loadGrid(meta, productId, taskSignal)
        .then((grid) => {
          gridCache.set(key, grid);
          return grid;
        })
        .finally(() => {
          // 成功/失败都移除在途记录：失败后下次可重试，不会永久占位
          pendingGrids.delete(key);
        })
    );
    pendingGrids.set(key, task);
  }

  return joinSharedTask(task, signal);
}

/**
 * 清空网格缓存（手动释放内存 / 调试）。
 *
 * 平时由条数上限（12 条）与字节预算（160MB）自动淘汰；
 * 如有特殊场景需要立即回收，可显式调用本函数。
 */
export function clearGridCache(): void {
  gridCache.clear();
}

/** 当前网格缓存条数（调试/测试用） */
export function gridCacheSize(): number {
  return gridCache.size;
}

/* ───────────────── RSTM 基数据体（9 仰角层）取数 ───────────────── */

/** 估算一份体数据的实际内存占用（所有层、所有径向、所有字段） */
function estimateVolumeBytes(volume: RstmVolume): number {
  let bytes = 0;
  for (const layer of volume.layers) {
    for (const radial of layer) {
      for (const field of Object.values(radial.fields)) bytes += field.byteLength;
    }
  }
  return bytes;
}

/**
 * RSTM 基数据体缓存。
 *
 * 单份体数据 = 9 层 × 数百条径向 × 9 个 Float32Array，实际体积可达上百 MB
 * （长短圈都保留，早期注释的 18MB 已不适用），因此同时受条数与字节预算约束。
 */
const volumeCache = new LruCache<RstmVolume>({
  maxEntries: 3,
  maxBytes: 384 * 1024 * 1024,
  estimate: estimateVolumeBytes
});

/** 在途请求合并表：多屏同步请求同一文件时只下载 + 解压 + 解析一次 */
const pendingVolumes = new Map<string, SharedTask<RstmVolume | null>>();

/**
 * “确认不是标准体数据”的文件负缓存。
 *
 * 这类文件走合成网格兜底，但每次切时次都重新下载 + 解压 + 试解析一次
 * 是纯浪费；记住后直接回退 fetchRadarGrid（其网格缓存仍按产品保存）。
 */
const noVolumeFiles = new Set<string>();
const NO_VOLUME_LIMIT = 20;

/** 记录“该文件不是标准体数据”（带上限，避免长时间运行无限累积） */
function markNoVolume(key: string): void {
  noVolumeFiles.add(key);
  while (noVolumeFiles.size > NO_VOLUME_LIMIT) {
    const oldest = noVolumeFiles.values().next().value;
    if (oldest === undefined) break;
    noVolumeFiles.delete(oldest);
  }
}

/**
 * 获取 RSTM 基数据体（带缓存与并发合并）。
 *
 * 与 fetchRadarGrid 的分工：
 *   - 本函数返回**真实基数据体**（9 仰角 × 数百条径向 × 9 个字段）；
 *     文件不是基数据体格式（旧合成文件 / 损坏文件）时返回 null，
 *     调用方回退 fetchRadarGrid 的合成网格；
 *   - 非体数据文件会被记入负缓存，后续时次不再重复下载/试解析；
 *   - 404 / 网络错误仍会抛出，与 fetchRadarGrid 的错误语义保持一致。
 *
 * @param meta   文件清单项
 * @param signal 取消信号（切换时次时 abort）
 */
export async function fetchRstmVolume(
  meta: RadarFileMeta,
  signal?: AbortSignal
): Promise<RstmVolume | null> {
  const key = meta.binFile;

  // 已确认不是标准体数据：不再重复下载/试解析，直接回退合成网格
  if (noVolumeFiles.has(key)) {
    if (signal?.aborted) throw abortError();
    return null;
  }

  const cached = volumeCache.get(key);
  if (cached) {
    if (signal?.aborted) throw abortError();
    return cached;
  }

  // 同键请求在途：复用共享任务；调用方取消只影响自己的等待
  let task = pendingVolumes.get(key);
  if (!task) {
    task = createSharedTask((taskSignal) =>
      loadVolume(meta, taskSignal)
        .then((vol) => {
          if (vol) volumeCache.set(key, vol);
          else markNoVolume(key);
          return vol;
        })
        .finally(() => {
          pendingVolumes.delete(key);
        })
    );
    pendingVolumes.set(key, task);
  }

  return joinSharedTask(task, signal);
}

/** 清空体数据缓存、负缓存与暂存 buffer（手动释放内存 / 允许重新探测文件） */
export function clearVolumeCache(): void {
  volumeCache.clear();
  noVolumeFiles.clear();
  clearFallbackBuffers();
}

/** 当前体数据缓存条数（调试/测试用） */
export function volumeCacheSize(): number {
  return volumeCache.size;
}
