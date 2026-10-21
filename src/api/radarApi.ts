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

import type { RadarFileMeta, RadarGrid, RstmVolume } from '../types';
import { parseRSTM } from '../parse/cinradParser';
import { parseRADAMOSAIC, isRADAMOSAIC } from '../parse/mosaicParser';
import { isMicapsM4, parseMicapsM4 } from '../parse/micapsM4Parser';
import { findProduct } from './productApi';
import { digits14ToISO, isoToMs, msToISO } from '../utils/datetime';
// 取数统一走带超时的 fetch：网络半开时不能永久停在“加载中…”
import { fetchWithTimeout } from '../utils/http';
// 雷达数据服务基地址（默认经 /radar-data/ 代理到 9099）
import { DATA_BASE_URL } from '../config/dataSource';
// .bz2 基数据在浏览器端解压（seek-bzip + buffer polyfill）
import { decompressBzip2, isBzip2Data } from '../utils/bzip2';
// RSTM 基数据体（9 仰角层）解析
import { parseRstmVolume } from '../parse/cinradVolume';

/** 数据文件不存在（HTTP 404）专用错误：UI 据此提示“该时次无数据”而非“加载失败” */
export class RadarFileMissingError extends Error {
  constructor(url: string) {
    super('数据文件不存在：' + url);
    this.name = 'RadarFileMissingError';
  }
}

/**
 * 把清单中的文件地址解析为可 fetch 的完整地址：
 *   - 绝对 URL / 协议相对 URL → 原样（配置里可直接写服务器地址）
 *   - 含 / 的相对路径（模板构造的文件名）→ 原样
 *   - 纯文件名（目录扫描 / 清单）→ 拼接数据服务基地址
 */
function resolveDataUrl(binFile: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(binFile) || binFile.startsWith('//')) return binFile;
  if (binFile.includes('/')) return binFile;
  return DATA_BASE_URL + binFile;
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

/** 加载并校验 JSON 清单（统一按观测时刻升序） */
async function loadManifest(url: string): Promise<RadarFileMeta[]> {
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    throw new Error('加载清单 ' + url + ' 失败：HTTP ' + resp.status);
  }
  const list = (await resp.json()) as RadarFileMeta[];
  if (!Array.isArray(list)) throw new Error('清单格式非法（应为数组）：' + url);
  // 双保险：确保按时间升序（时间轴顺序依赖）
  return list.sort((a, b) => (a.time < b.time ? -1 : 1));
}

/** 目录索引中明显不是雷达数据的文件（在解析 href 时先排除） */
const NON_DATA_EXT = /\.(json|txt|html?|css|js|png|jpe?g|gif|svg|ico|map)$/i;

/**
 * 从文件名推断清单项；无法识别扩展名或没有 14 位时刻时返回 null。
 *
 * 压缩文件处理：`.bz2` 只是分发压缩，不是数据格式本身。
 * 先剥掉 `.bz2` 再判断内部格式，并打上 `compressed` 标记；
 * 取数阶段解压后还会用二进制魔数复核（见 detectFormat），文件名不规范也能纠正。
 */
function buildMetaFromFileName(name: string): RadarFileMeta | null {
  const t = name.match(/(\d{14})/);
  if (!t) return null;

  const compressed = /\.bz2$/i.test(name);
  const plain = compressed ? name.replace(/\.bz2$/i, '') : name;

  let format: RadarFileMeta['format'];
  if (/\.m4$/i.test(plain)) format = 'm4';
  else if (/RADAMOSAIC/i.test(plain)) format = 'mosaic';
  else if (/\.bin$/i.test(plain)) format = 'rstm';
  else return null;

  // RSTM 命名：Z_RADR_I_Z9517_...；m4 命名：Z9517_20261018..._dBZ_...
  const station = plain.match(/_I_(Z[A-Z0-9]+)_/) ?? plain.match(/^(Z[A-Z0-9]+)_/);
  return {
    file: name,
    binFile: name, // 纯文件名：取数时拼数据服务基地址
    time: digits14ToISO(t[1]),
    stationId: station?.[1] ?? (format === 'mosaic' ? 'RADAMOSAIC' : ''),
    stationName: station?.[1] ?? '',
    hasData: true,
    format,
    compressed
  };
}

/**
 * 扫描静态服务器的目录索引（nginx autoindex 的 <a href> 列表）自动生成清单。
 *
 * 纳入的格式（浏览器端均可处理）：
 *   - .m4      ：MICAPS 文本
 *   - .bin     ：SWAN 拼图 / CINRAD RSTM（按文件名判断，取数时魔数复核）
 *   - .bin.bz2 ：同上，取数阶段用 seek-bzip 在浏览器端解压
 */
async function scanDataDirectory(): Promise<RadarFileMeta[]> {
  const resp = await fetchWithTimeout(DATA_BASE_URL);
  if (!resp.ok) throw new Error('目录索引不可用：HTTP ' + resp.status);
  const html = await resp.text();

  const names = Array.from(html.matchAll(/href="([^"?/][^"]*)"/g))
    .map((m) => decodeURIComponent(m[1]))
    .filter((n) => !n.endsWith('/') && !NON_DATA_EXT.test(n));

  const files: RadarFileMeta[] = [];
  let compressedCount = 0;

  for (const name of names) {
    const meta = buildMetaFromFileName(name);
    if (!meta) continue;
    if (meta.compressed) compressedCount++;
    files.push(meta);
  }

  if (compressedCount > 0) {
    console.info(
      `[radarApi] 目录中含 ${compressedCount} 个 .bz2 压缩文件，将在浏览器端解压后解析`
    );
  }
  if (files.length === 0) throw new Error('目录中没有可解析的雷达文件');

  return files.sort((a, b) => (a.time < b.time ? -1 : 1));
}

/**
 * 获取雷达文件清单（清单模式）。
 *
 * 数据源为外部静态服务（默认 /radar-data/ → 9099），按以下顺序尝试：
 *   1) 配置显式指定的清单地址（严格模式，失败即抛错）；
 *   2) 数据服务根下的 manifest.json；
 *   3) 扫描目录索引自动生成（.bz2 会纳入，取数时浏览器端解压）；
 *   4) 回退本地 data/manifest.json（离线 demo）。
 *
 * @param url 可选：配置指定的清单地址
 * @returns RadarFileMeta[]（已按观测时刻升序）
 */
export async function fetchRadarFileList(url?: string): Promise<RadarFileMeta[]> {
  if (url) return loadManifest(url);

  try {
    return await loadManifest(DATA_BASE_URL + 'manifest.json');
  } catch (e) {
    console.warn('[radarApi] 数据服务未提供 manifest.json，改为扫描目录索引：', e);
  }

  try {
    return await scanDataDirectory();
  } catch (e) {
    console.warn('[radarApi] 目录索引不可用，回退本地 data/manifest.json：', e);
  }

  return loadManifest('data/manifest.json');
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
 * 从二进制内容识别格式（取数阶段唯一入口）。
 *
 * 识别顺序：
 *   1) 魔数：'RSTM' → rstm；'SWAN' → mosaic；
 *   2) 文本：以 "diamond 4" 开头 → m4；
 *   3) 都不匹配 → 回退清单/文件名推断（解析器内部仍有兜底）。
 *
 * ★ 为什么必须以内容为准 ★
 *   .bz2 解压前不知道真实格式；清单可能缺失 format 或与内容不符；
 *   文件名也可能不规范。只看元数据会把 SWAN 拼图误当 RSTM 解析。
 */
function detectFormat(buffer: ArrayBuffer, meta: RadarFileMeta): RadarFileMeta['format'] {
  const head = new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength));
  const magic = String.fromCharCode(...head);

  if (magic.startsWith('RSTM')) return 'rstm';
  if (magic.startsWith('SWAN')) return 'mosaic';

  // MICAPS m4 为文本：首行形如 "diamond 4 2024..."（大小写不敏感）
  if (/^\s*diamond\s+4/i.test(new TextDecoder('utf-8').decode(head))) return 'm4';

  return guessFormat(meta);
}

/**
 * 按元数据推断格式（内容识别失败时的兜底）。
 *
 * 注意：`format` 在类型上是必填，但清单来自外部 JSON，
 * 运行时仍可能缺字段，因此保留空值判断，不写成死分支。
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

/* ───────────────── RSTM 基数据体（9 仰角层）取数 ───────────────── */

/**
 * RSTM 基数据体的 LRU 缓存。
 *
 * 体积远大于普通网格：9 层 × 45 方位 × 6 字段 × 1840 库 ≈ 448 万个 Float32
 * （约 18MB/份），因此上限设为 3 份（约 54MB），命中范围覆盖“播放 + 仰角切换”。
 */
const volumeCache = new Map<string, RstmVolume>();
const VOLUME_CACHE_LIMIT = 3;

/** 在途请求合并表：多屏同步请求同一文件时只下载 + 解压 + 解析一次 */
const pendingVolumes = new Map<string, Promise<RstmVolume | null>>();

/**
 * 获取 RSTM 基数据体（带缓存与并发合并）。
 *
 * 与 fetchRadarGrid 的分工：
 *   - 本函数返回**真实基数据体**（9 仰角 × 45 方位 × 6 字段）；
 *     文件不是基数据体格式（旧合成文件 / 损坏文件）时返回 null，
 *     调用方回退 fetchRadarGrid 的合成网格。
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

  const cached = volumeCache.get(key);
  if (cached) {
    // 命中后移到末尾，维护“最近使用序”
    volumeCache.delete(key);
    volumeCache.set(key, cached);
    return cached;
  }

  const pending = pendingVolumes.get(key);
  if (pending) return pending;

  const task = loadVolume(meta, signal)
    .then((vol) => {
      // 非基数据体格式不缓存（下次仍要回退合成），避免占满 3 个位置
      if (vol) {
        volumeCache.delete(key);
        volumeCache.set(key, vol);
        while (volumeCache.size > VOLUME_CACHE_LIMIT) {
          const oldest = volumeCache.keys().next().value;
          if (oldest === undefined) break;
          volumeCache.delete(oldest);
        }
      }
      return vol;
    })
    .finally(() => {
      pendingVolumes.delete(key);
    });

  pendingVolumes.set(key, task);
  return task;
}

/**
 * 下载并解析 RSTM 基数据体（不含缓存）。
 *
 * 流程：fetch（必要时解压 bz2）→ parseRstmVolume（结构校验 + 解析）。
 * @returns RstmVolume；文件不是基数据体格式时返回 null（不抛错）
 */
async function loadVolume(
  meta: RadarFileMeta,
  signal?: AbortSignal
): Promise<RstmVolume | null> {
  const url = resolveDataUrl(meta.binFile);
  const resp = await fetchWithTimeout(url, undefined, signal);
  if (resp.status === 404) {
    throw new RadarFileMissingError(url);
  }
  if (!resp.ok) {
    throw new Error('加载 ' + meta.binFile + ' 失败：HTTP ' + resp.status);
  }

  let buf = await resp.arrayBuffer();

  // .bz2 压缩的基数据：先解压再解析（与 loadGrid 的解压分支一致）
  if (meta.compressed || /\.bz2$/i.test(meta.binFile)) {
    if (!isBzip2Data(buf)) {
      throw new Error(meta.binFile + ' 不是有效的 bzip2 文件');
    }
    buf = decompressBzip2(buf);
  }

  // parseRstmVolume 会做结构校验：合成/损坏文件返回 null → 调用方走合成兜底
  return parseRstmVolume(buf);
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

  let buf = await resp.arrayBuffer();

  // —— 1.5) bzip2 解压 ——
  // 雷达基数据常以 .bin.bz2 分发，浏览器端用 seek-bzip 解压后再解析。
  // 解压后 buf 就是原始基数据，后续格式识别与未压缩文件完全一致。
  if (meta.compressed || /\.bz2$/i.test(meta.binFile)) {
    if (!isBzip2Data(buf)) {
      throw new Error(meta.binFile + ' 不是有效的 bzip2 文件');
    }
    try {
      buf = decompressBzip2(buf);
    } catch (e) {
      // 解压失败通常是文件损坏或传输被截断，带上原因便于排查
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(meta.binFile + ' bzip2 解压失败：' + reason);
    }
  }

  // —— 2) 格式识别并分派解析器（魔数优先：bz2 解压后才知真实格式） ——
  const format = detectFormat(buf, meta);
  let grid: RadarGrid;
  if (format === 'm4') {
    // MICAPS 第 4 类：文本格式
    const text = new TextDecoder('utf-8').decode(buf);
    if (!isMicapsM4(text)) throw new Error(meta.binFile + ' 不是合法的 MICAPS diamond 4 文件');
    grid = parseMicapsM4(text, { product, fallbackTime: meta.time });
    grid.time = meta.time || grid.time;
  } else if (format === 'mosaic' || isRADAMOSAIC(buf)) {
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
