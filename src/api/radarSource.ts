/**
 * api/radarSource.ts —— 雷达文件下载、解压与解析
 *
 * 职责（本文件不关心缓存与时间轴）：
 *   - fetchAndDecompress：统一 fetch + bz2 解压 + 404 语义；
 *   - loadGrid / loadVolume：按魔数识别格式并分派解析器；
 *   - parseUploadedFile：用户上传文件的格式识别与解析（RSTM 体数据返回 volume 供仰角切换）；
 *   - 体数据解析失败时暂存已解压 buffer，供回退 fetchRadarGrid 复用。
 *
 * 依赖方向：radarSource → radarManifest（路径）/ radarCache（取消错误）/ parse。
 */

import type { RadarFileMeta, RadarGrid, RstmVolume } from '../types';
import { parseRSTM } from '../parse/cinradParser';
import { parseRADAMOSAIC, isRADAMOSAIC } from '../parse/mosaicParser';
import { isMicapsM4, parseMicapsM4 } from '../parse/micapsM4Parser';
import { parseRstmVolume } from '../parse/cinradVolume';
import { findProduct } from './productApi';
import { resolveDataUrl } from './radarManifest';
import { abortError } from './radarCache';
import { digits14ToISO, isoToMs, msToISO } from '../utils/datetime';
import { fetchWithTimeout } from '../utils/http';
import { decompressBzip2, isBzip2Data } from '../utils/bzip2';

/** 数据文件不存在（HTTP 404）专用错误：UI 据此提示“该时次无数据”而非“加载失败” */
export class RadarFileMissingError extends Error {
  constructor(url: string) {
    super('数据文件不存在：' + url);
    this.name = 'RadarFileMissingError';
  }
}

/* ───────────────────────── 用户上传文件 ───────────────────────── */

/** 上传文件大小上限（200MB）：再大 arrayBuffer() 全量读入内存，标签页可能直接崩溃 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * 用户上传文件的解析结果（按内容判别）：
 *   - kind='volume'：RSTM 标准基数据体（9 仰角层），栅格化由调用方按
 *     当前产品字段与仰角层执行（volumeToGrid），支持上传后切换仰角；
 *   - kind='grid'  ：拼图 / m4 / 合成 RSTM，grid 可直接渲染（无仰角维度）。
 */
export type UploadedRadarData =
  | { kind: 'volume'; volume: RstmVolume }
  | { kind: 'grid'; grid: RadarGrid };

/**
 * 解析用户上传的雷达数据文件（自主上传功能）。
 *
 * 格式识别（按序判定）：
 *   1) CINRAD 单站 RSTM（头部 "RSTM" 魔数）→ 优先解析标准基数据体
 *      （9 仰角层；结构校验失败回退下方单层合成兜底）
 *   2) MICAPS m4 文本（头部 "diamond 4"；先于 mosaic 判定，两者头部同以 "diamond" 开头）
 *   3) SWAN 拼图二进制（头部 "diamond"）
 * 均不符合时抛错，UI 提示格式不符。
 *
 * 时刻来源：优先文件名中的 14 位时间串，其次文件最后修改时间。
 * 注意：.bz2 压缩文件（.bin.bz2 / .m4.bz2 等）按内容魔数 BZh 判断，
 * 在浏览器端用 seek-bzip 解压后再做格式识别（compressjs 仅 Node 可用，不可用）。
 *
 * @param file      用户选择的文件
 * @param productId 产品代码（决定单位与合成兜底峰值）
 * @returns 基数据体（volume）或单层网格（grid），二者必有其一
 * @throws 文件格式不符合预设格式时抛错
 */
export async function parseUploadedFile(
  file: File,
  productId: string
): Promise<UploadedRadarData> {
  // 先卡体积再读文件：arrayBuffer 会把整个文件读进内存，超大文件会直接 OOM
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `文件过大（${(file.size / 1024 / 1024).toFixed(0)}MB），上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`
    );
  }
  let buf = await file.arrayBuffer();
  const product = findProduct(productId);

  // —— .bz2 压缩文件：按内容魔数 BZh 判断（不依赖扩展名），解压后再识别格式 ——
  // 雷达基数据常以 .bin.bz2 分发，上传目录里同样常见；解压后与未压缩文件共用后续魔数识别。
  if (isBzip2Data(buf)) {
    try {
      buf = decompressBzip2(buf);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error('bzip2 解压失败：' + reason);
    }
  }

  // —— 时刻：优先文件名中的 14 位时间串，其次文件最后修改时间 ——
  // 两种来源都统一经 utils/datetime 转成平台 ISO 串，避免格式漂移
  const m = file.name.match(/(\d{14})/);
  const time = m ? digits14ToISO(m[1]) : msToISO(file.lastModified);
  const station = file.name.match(/_I_(Z[A-Z0-9]+)_/);

  // —— 0) CINRAD 单站 RSTM："RSTM" 魔数 → 优先解析 9 仰角层标准基数据体 ——
  // 结构校验失败（旧合成文件 / 损坏文件）时 parseRstmVolume 返回 null，
  // 继续走下方单层合成兜底（与改造前行为一致）
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, Math.min(4, buf.byteLength)));
  if (magic === 'RSTM') {
    const volume = parseRstmVolume(buf);
    if (volume) return { kind: 'volume', volume };
  }

  // —— 1) MICAPS m4：用前 256 字节探测首行 "diamond 4" ——
  const probe = new TextDecoder('utf-8').decode(buf.slice(0, 256));
  if (isMicapsM4(probe)) {
    return {
      kind: 'grid',
      grid: parseMicapsM4(new TextDecoder('utf-8').decode(buf), { product, fallbackTime: time })
    };
  }
  // —— 2) SWAN 拼图：头部 "diamond" ——
  if (isRADAMOSAIC(buf)) {
    return { kind: 'grid', grid: parseRADAMOSAIC(buf, { time, product }) };
  }
  // —— 3) CINRAD 单站 RSTM 单层（合成兜底，永不抛错） ——
  if (magic === 'RSTM') {
    return {
      kind: 'grid',
      grid: parseRSTM(buf, {
        time,
        product,
        stationId: station?.[1] ?? '',
        stationName: station?.[1] ?? ''
      })
    };
  }
  throw new Error('文件格式不符合预设（支持：SWAN 拼图 / CINRAD RSTM / MICAPS m4）');
}

/* ───────────────── 体数据失败时的 buffer 复用 ───────────────── */

/**
 * “体数据解析失败时已解压的原始 buffer”暂存区。
 *
 * 非标准 RSTM 文件会走 fetchRadarGrid 的合成兜底；若不暂存，同一文件会被
 * 第二次下载 + 解压。这里只在上限 2 条内保留，消费后立即删除。
 */
const fallbackBuffers = new Map<string, ArrayBuffer>();
const FALLBACK_BUFFER_LIMIT = 2;

/** 暂存一份已解压的 buffer（带上限，避免失败文件堆积占用内存） */
function rememberFallbackBuffer(key: string, buffer: ArrayBuffer): void {
  fallbackBuffers.delete(key);
  fallbackBuffers.set(key, buffer);
  while (fallbackBuffers.size > FALLBACK_BUFFER_LIMIT) {
    const oldest = fallbackBuffers.keys().next().value;
    if (oldest === undefined) break;
    fallbackBuffers.delete(oldest);
  }
}

/** 取走一份暂存的 buffer（一次性消费；没有则返回 null） */
function takeFallbackBuffer(key: string): ArrayBuffer | null {
  const buffer = fallbackBuffers.get(key);
  if (!buffer) return null;
  fallbackBuffers.delete(key);
  return buffer;
}

/** 清空暂存 buffer（清体数据缓存 / 允许重新探测文件时调用） */
export function clearFallbackBuffers(): void {
  fallbackBuffers.clear();
}

/* ───────────────── 格式识别与解析 ───────────────── */

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

/**
 * 下载并解压一个雷达文件（不解析）。
 *
 * 404 / 非 2xx / 解压失败都转成带文件名与原因的 Error；
 * 404 单独抛 RadarFileMissingError，供 UI 提示“该时次无数据”。
 */
async function fetchAndDecompress(
  meta: RadarFileMeta,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const url = resolveDataUrl(meta.binFile);
  const resp = await fetchWithTimeout(url, undefined, signal);
  if (resp.status === 404) throw new RadarFileMissingError(url);
  if (!resp.ok) {
    throw new Error('加载 ' + meta.binFile + ' 失败：HTTP ' + resp.status);
  }

  let buf = await resp.arrayBuffer();

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

  return buf;
}

/**
 * 下载并解析 RSTM 基数据体（不含缓存）。
 *
 * 流程：fetch（必要时解压 bz2）→ parseRstmVolume（结构校验 + 解析）。
 * @returns RstmVolume；文件不是基数据体格式时返回 null（不抛错）
 */
export async function loadVolume(
  meta: RadarFileMeta,
  signal?: AbortSignal
): Promise<RstmVolume | null> {
  const buf = await fetchAndDecompress(meta, signal);

  // parseRstmVolume 会做结构校验：合成/损坏文件返回 null → 调用方走合成兜底
  const volume = parseRstmVolume(buf);
  // 非体数据：把已解压 buffer 留给回退的 loadGrid，避免二次下载/解压
  if (!volume) rememberFallbackBuffer(meta.binFile, buf);
  return volume;
}

/**
 * 下载 + 解析为雷达网格（不含缓存）。
 *
 * 流程：取二进制（优先复用体数据失败 buffer）→ 格式识别 → 分派解析器 → RadarGrid。
 */
export async function loadGrid(
  meta: RadarFileMeta,
  productId: string,
  signal?: AbortSignal
): Promise<RadarGrid> {
  // 产品元信息：用于合成兜底的峰值/单位标注
  const product = findProduct(productId);

  // —— 1) 取二进制：优先复用 RSTM 体数据解析失败时留下的已解压 buffer ——
  //    否则下载 + 解压；两条路径得到同一份原始基数据。
  if (signal?.aborted) throw abortError();
  const buf = takeFallbackBuffer(meta.binFile) ?? (await fetchAndDecompress(meta, signal));

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
          `[radarSource] ${meta.binFile} 文件头时间(${headerTime})与清单时间(${listTime})不一致，以文件头为准`
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
