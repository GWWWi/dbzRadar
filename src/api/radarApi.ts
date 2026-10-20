/**
 * api/radarApi.ts —— 获取雷达文件的接口（数据访问层）
 *
 * ────────────────────────────────────────────────────────────────────────
 * 接口约定（两个入口）：
 *
 *   1) fetchRadarFileList(): Promise<RadarFileMeta[]>
 *      读取 public/data/manifest.json，返回雷达文件清单
 *      （站号 / 观测时刻 / 数据格式 / 是否含真实数据）。
 *      时间轴即由清单中各文件的 time 推导。
 *
 *   2) fetchRadarGrid(meta, productId): Promise<RadarGrid>
 *      按清单项 fetch 对应的数据文件 → 识别格式 → 分派解析器，
 *      返回渲染器可直接消费的笛卡尔网格 RadarGrid。
 *
 * ★ 取数缓存（播放 / 多屏性能）★
 *   fetchRadarGrid 内部带 LRU 缓存（12 条）并做在途请求合并：
 *   同一 binFile+productId 只下载、解析一次；多屏同步时各屏拿到同一个网格对象。
 *   因此返回的 grid 是共享对象，调用方只能只读（渲染层在副本上过滤弱值）。
 *
 *      注意：.bz2 原始压缩文件由 scripts/prepare-data.cjs 在 Node 端
 *      预先解压为 .bin（清单中的 binFile 字段），前端只消费解压后的
 *      二进制，不在浏览器内做 bz2 解压（compressjs 与打包器互操作差，
 *      会因 amdefine 在浏览器环境崩溃导致白屏）。
 *
 * 文件路径两种获取方式（见 configApi）：
 *   - 模板模式：buildFileMetaFromTemplate 按配置模板 + 时刻直接构造地址；
 *     404 时抛 RadarFileMissingError，UI 提示“该时次无数据”。
 *   - 清单模式：fetchRadarFileList(配置地址) 拉清单，按时间精确匹配。
 *
 * 后端接入说明：清单地址/模板地址均可指向服务器任意目录（相对路径或
 * 绝对 URL），上层组件无需改动。
 * ────────────────────────────────────────────────────────────────────────
 */

import type { RadarFileMeta, RadarGrid } from '../types';
import { parseRSTM } from '../parse/cinradParser';
import { parseRADAMOSAIC, isRADAMOSAIC } from '../parse/mosaicParser';
import { isMicapsM4, parseMicapsM4 } from '../parse/micapsM4Parser';
import { findProduct } from './productApi';
import { digits14ToISO, isoToMs, msToISO } from '../utils/datetime';
// 取数统一走带超时的 fetch：网络半开时不能永久停在“加载中…”
import { fetchWithTimeout } from '../utils/http';

/** 数据文件不存在（HTTP 404）专用错误：UI 据此提示“该时次无数据”而非“加载失败” */
export class RadarFileMissingError extends Error {
  constructor(url: string) {
    super('数据文件不存在：' + url);
    this.name = 'RadarFileMissingError';
  }
}

/**
 * 把相对文件名解析为可 fetch 的地址：
 *   - 含 / 或 ://（模板构造的路径、绝对 URL）→ 原样使用
 *   - 纯文件名（清单模式）→ 相对 data/ 目录
 */
function resolveDataUrl(binFile: string): string {
  return /[/]|:\/\//.test(binFile) ? binFile : 'data/' + binFile;
}

/**
 * 按地址模板构造某时刻的文件清单项（模板模式，无清单时使用）。
 * @param template 地址模板，{time} 占位符替换为 yyyyMMddHHmmss（如 data/files/{time}.bin）
 * @param time     ISO 时刻串 'yyyy-MM-ddTHH:mm:ss'
 */
export function buildFileMetaFromTemplate(template: string, time: string): RadarFileMeta {
  const compact = time.replace(/[-:]/g, '').replace('T', '');
  const binFile = template.replace('{time}', compact);
  return {
    file: binFile,
    binFile,
    time,
    stationId: '',
    stationName: '',
    hasData: true,
    format: 'rstm' // 实际格式由 fetchRadarGrid 的魔数检测兜底纠正
  };
}

/**
 * 获取雷达文件清单（清单模式）。
 * @param url 清单地址（默认 data/manifest.json，可传入配置指定的任意地址）
 * @returns RadarFileMeta[] 清单数组（已按观测时刻升序）
 */
export async function fetchRadarFileList(url = 'data/manifest.json'): Promise<RadarFileMeta[]> {
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    throw new Error('加载清单 ' + url + ' 失败：HTTP ' + resp.status);
  }
  const list = (await resp.json()) as RadarFileMeta[];
  // 双保险：确保按时间升序（时间轴顺序依赖）
  return list.sort((a, b) => (a.time < b.time ? -1 : 1));
}

/**
 * 解析用户上传的雷达数据文件（自主上传功能）。
 *
 * 格式识别（预设三种，按序判定）：
 *   1) MICAPS m4 文本（头部 "diamond 4"；先于 mosaic 判定，两者头部同以 "diamond" 开头）
 *   2) SWAN 拼图二进制（头部 "diamond"）
 *   3) CINRAD 单站 RSTM（头部 "RSTM" 魔数）
 * 均不符合时抛错，UI 提示格式不符。
 *
 * 时刻来源：优先文件名中的 14 位时间串，其次文件最后修改时间。
 * 注意：.bz2 压缩包无法在浏览器解压（compressjs 仅 Node 可用），不在支持范围。
 *
 * @param file      用户选择的文件
 * @param productId 产品代码（决定单位与合成兜底峰值）
 * @returns 解析后的网格
 * @throws 文件格式不符合预设格式时抛错
 */
/** 上传文件大小上限（200MB）：再大 arrayBuffer() 全量读入内存，标签页可能直接崩溃 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export async function parseUploadedFile(file: File, productId: string): Promise<RadarGrid> {
  // 先卡体积再读文件：arrayBuffer 会把整个文件读进内存，超大文件会直接 OOM
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `文件过大（${(file.size / 1024 / 1024).toFixed(0)}MB），上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`
    );
  }
  const buf = await file.arrayBuffer();
  const product = findProduct(productId);

  // —— 时刻：优先文件名中的 14 位时间串，其次文件最后修改时间 ——
  // 两种来源都统一经 utils/datetime 转成平台 ISO 串，避免格式漂移
  const m = file.name.match(/(\d{14})/);
  const time = m ? digits14ToISO(m[1]) : msToISO(file.lastModified);
  const station = file.name.match(/_I_(Z[A-Z0-9]+)_/);

  // —— 1) MICAPS m4：用前 256 字节探测首行 "diamond 4" ——
  const probe = new TextDecoder('utf-8').decode(buf.slice(0, 256));
  if (isMicapsM4(probe)) {
    return parseMicapsM4(new TextDecoder('utf-8').decode(buf), { product, fallbackTime: time });
  }
  // —— 2) SWAN 拼图：头部 "diamond" ——
  if (isRADAMOSAIC(buf)) {
    return parseRADAMOSAIC(buf, { time, product });
  }
  // —— 3) CINRAD 单站 RSTM："RSTM" 魔数 ——
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, Math.min(4, buf.byteLength)));
  if (magic === 'RSTM') {
    return parseRSTM(buf, {
      time,
      product,
      stationId: station?.[1] ?? '',
      stationName: station?.[1] ?? ''
    });
  }
  throw new Error('文件格式不符合预设（支持：SWAN 拼图 / CINRAD RSTM / MICAPS m4）');
}

/**
 * 从文件名推断格式（清单缺失 format 字段时的兜底判断）：
 *   - Z_OTHE_RADAMOSAIC_*.bin   → 'mosaic'
 *   - Z_RADR_I_Z95xx_*.bin(.bz2)→ 'rstm'
 *   - *.m4                      → 'm4'
 */
function guessFormat(meta: RadarFileMeta): RadarFileMeta['format'] {
  if (meta.format) return meta.format;
  if (/\.m4$/i.test(meta.file)) return 'm4';
  if (/RADAMOSAIC/i.test(meta.file)) return 'mosaic';
  return 'rstm';
}

/* ───────────────────────── 解析结果缓存（播放 / 多屏性能） ───────────────────────── */

/**
 * 已解析网格的 LRU 缓存。
 *
 * 目的：播放（800ms 一档）与时间轴来回拖动会反复请求同一时次。
 * 没有缓存时每次都要重新下载并解析 168 万点，主线程会被解析占满。
 *
 * 键 = binFile|productId：解析结果依赖产品（单位、合成兜底峰值），
 * 因此同一文件的不同产品必须分开缓存。
 */
const gridCache = new Map<string, RadarGrid>();

/** 缓存条数上限：Float32 网格约 6.7MB/条（168 万点），12 条约 80MB */
const GRID_CACHE_LIMIT = 12;

/**
 * 在途请求合并表。
 * 多屏同步（syncPlay）时各屏会在同一帧内请求同一时次，
 * 合并后只发生一次 fetch + 一次解析，各屏共享同一个网格对象。
 */
const pendingGrids = new Map<string, Promise<RadarGrid>>();

/** 缓存键：文件名 + 产品（模板模式与清单模式对同一文件共用缓存） */
function cacheKey(meta: RadarFileMeta, productId: string): string {
  return meta.binFile + '|' + productId;
}

/**
 * 读缓存，并把命中项移到 Map 末尾。
 * 利用 Map 的插入顺序维护“最近使用序”，末尾即最新，队首即最久未用。
 */
function getCachedGrid(key: string): RadarGrid | undefined {
  const hit = gridCache.get(key);
  if (!hit) return undefined;
  gridCache.delete(key);
  gridCache.set(key, hit);
  return hit;
}

/** 写入缓存并淘汰最久未使用的条目（LRU） */
function putCachedGrid(key: string, grid: RadarGrid): void {
  gridCache.delete(key);
  gridCache.set(key, grid);
  while (gridCache.size > GRID_CACHE_LIMIT) {
    const oldest = gridCache.keys().next().value;
    if (oldest === undefined) break;
    gridCache.delete(oldest);
  }
}

/**
 * 获取某个文件、某个产品对应的雷达网格（核心取数方法，带缓存与并发合并）。
 *
 * 三条路径：
 *   1. 缓存命中 → 直接返回（播放回退、多屏共享同一对象，零解析成本）；
 *   2. 同键请求在途 → 复用同一个 Promise（4 屏同步只下载 + 解析一次）；
 *   3. 否则 → 执行 loadGrid，成功后写入缓存。
 *
 * ★ 返回的网格可能被多个屏共享，调用方必须只读 ★
 *   渲染层在副本上过滤弱值、取值函数只读，已满足该约束。
 *
 * @param meta      文件清单项
 * @param productId 产品代码（如 'Z' 基本反射率），决定单位与兜底峰值
 * @returns 解析后的网格；404 抛 RadarFileMissingError，其余错误原样抛出
 */
export async function fetchRadarGrid(
  meta: RadarFileMeta,
  productId: string,
  signal?: AbortSignal
): Promise<RadarGrid> {
  const key = cacheKey(meta, productId);

  const cached = getCachedGrid(key);
  if (cached) return cached;

  const pending = pendingGrids.get(key);
  if (pending) return pending;

  const task = loadGrid(meta, productId, signal)
    .then((grid) => {
      putCachedGrid(key, grid);
      return grid;
    })
    .finally(() => {
      // 成功/失败都移除在途记录：失败后下次可重试，不会永久占位
      pendingGrids.delete(key);
    });

  pendingGrids.set(key, task);
  return task;
}

/**
 * 清空网格缓存（切换布局 / 卸载面板时调用）。
 *
 * 缓存是模块级常量，不清理的话：单条 mosaic 约 6.7MB（Float32Array），
 * 12 条约 80MB；6 屏 + 反复切换时次会持续累积。缓存对象本身没有生命周期，
 * 只能由调用方在合适的时机显式回收。
 */
export function clearGridCache(): void {
  gridCache.clear();
}

/** 当前缓存条数（调试/测试用） */
export function gridCacheSize(): number {
  return gridCache.size;
}

/**
 * 真正的下载 + 解析实现（不含缓存）。
 *
 * 流程：fetch 解压后的二进制 → 格式识别 → 分派解析器 → RadarGrid。
 */
async function loadGrid(
  meta: RadarFileMeta,
  productId: string,
  signal?: AbortSignal
): Promise<RadarGrid> {
  // 产品元信息：用于合成兜底的峰值/单位标注
  const product = findProduct(productId);

  // —— 1) 拉取文件二进制（清单模式为 data/ 下文件名；模板模式为构造出的完整地址） ——
  const url = resolveDataUrl(meta.binFile);
  const resp = await fetchWithTimeout(url, undefined, signal);
  if (resp.status === 404) {
    throw new RadarFileMissingError(url);
  }
  if (!resp.ok) {
    throw new Error('加载 ' + meta.binFile + ' 失败：HTTP ' + resp.status);
  }
  const buf = await resp.arrayBuffer();

  // —— 2) 格式识别并分派解析器 ——
  let grid: RadarGrid;
  if (guessFormat(meta) === 'm4') {
    // MICAPS 第 4 类：文本格式
    const text = new TextDecoder('utf-8').decode(buf);
    if (!isMicapsM4(text)) throw new Error(meta.binFile + ' 不是合法的 MICAPS diamond 4 文件');
    grid = parseMicapsM4(text, { product, fallbackTime: meta.time });
    grid.time = meta.time || grid.time;
  } else if (meta.format === 'mosaic' || isRADAMOSAIC(buf)) {
    // SWAN 雷达三维拼图：取默认高度层的反射率。
    // 先不传 time，让解析器从文件头取时刻，再与清单交叉校验——原实现
    // 无条件以文件名为准，实测出现过「文件名 2024、文件头 2022」的数据
    // 被当作当前时次回波展示，属于业务级误导。
    grid = parseRADAMOSAIC(buf, { product });
    const headerTime = grid.time || '';
    const listTime = meta.time || '';
    if (headerTime && listTime) {
      const delta = Math.abs(isoToMs(headerTime) - isoToMs(listTime));
      if (Number.isFinite(delta) && delta > 60_000) {
        console.warn(
          `[radarApi] ${meta.binFile} 文件头时间(${headerTime})与清单时间(${listTime})不一致，以文件头为准`
        );
      } else {
        // 差异在 1 分钟内视为同一时次，沿用清单写法（与时间轴、文件名同源）
        grid.time = listTime;
      }
    } else {
      grid.time = listTime || headerTime;
    }
  } else {
    // CINRAD 单站 RSTM（含合成兜底，永不抛错）
    grid = parseRSTM(buf, {
      time: meta.time,
      product,
      stationId: meta.stationId,
      stationName: meta.stationName
    });
    grid.time = meta.time || grid.time;
  }

  return grid;
}
