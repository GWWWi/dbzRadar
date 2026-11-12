/**
 * api/radarSource.ts —— 雷达文件下载、解压与解析
 *
 * 职责（本文件不关心缓存与时间轴）：
 *   - fetchAndDecompress：统一 fetch + bz2 解压（Worker）+ 404 语义；
 *   - loadGrid / loadVolume：把已解压二进制交给解码 Worker 解析
 *     （格式识别与分派统一在 radarFormat，取数/上传共用一套）；
 *   - parseUploadedFile：用户上传文件的解析（RSTM 体数据保留仰角维度）；
 *   - 体数据解析失败时暂存已解压 buffer，供回退 fetchRadarGrid 复用。
 *
 * ★ CPU 密集操作全部走 Worker ★ 解压/解析经 decodeClient.runDecode 执行，
 * Worker 不可用时自动回退主线程同步执行同一套纯函数（功能不缺失）。
 *
 * 依赖方向：radarSource → radarFormat（分派）/ radarManifest（路径）/
 * radarCache（取消错误）/ decodeClient（Worker）。
 */

import type { RadarFileMeta, RadarGrid, RadarParsedData, RstmVolume } from '../types';
import { findProduct } from './productApi';
import { resolveDataUrl } from './radarManifest';
import { abortError } from './radarCache';
import { runDecode } from './decodeClient';
import { digits14ToISO, msToISO } from '../utils/datetime';
import { fetchWithTimeout } from '../utils/http';
import { isBzip2Data } from '../utils/bzip2';

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
 * 上传失败原因码：
 *   size   超过 200MB 上限；decode bz2 解压失败（文件损坏/被截断）；
 *   format 不是受支持的格式；empty  格式对但解不出有效数据。
 * 屏头状态按原因分别提示——此前一律显示「文件格式不符」，
 * 会把“文件太大”“文件损坏”误导成“格式不对，去转换格式”。
 */
export type UploadErrorReason = 'size' | 'decode' | 'format' | 'empty';

/** 上传文件错误：带原因码，message 直接面向用户展示 */
export class UploadFileError extends Error {
  readonly reason: UploadErrorReason;

  constructor(reason: UploadErrorReason, message: string) {
    super(message);
    this.name = 'UploadFileError';
    this.reason = reason;
  }
}

/**
 * 用户上传文件的解析结果（与取数链路共用 RadarParsedData 契约）：
 *   - kind='volume'：RSTM 标准基数据体（9 仰角层），栅格化由调用方按
 *     当前产品字段与仰角层执行，支持上传后切换仰角；
 *   - kind='grid'  ：拼图 / m4 / 合成 RSTM，grid 可直接渲染（无仰角维度）。
 */
export type UploadedRadarData = RadarParsedData;

/**
 * 解析用户上传的雷达数据文件（自主上传功能）。
 *
 * 格式识别与分派和服务器取数共用 radarFormat.parseRadarBuffer（strict 模式：
 * 魔数不认识时报格式不符，不回退文件名推断）。RSTM 优先解析标准基数据体，
 * 结构校验失败回退单层合成兜底。
 *
 * 时刻来源：优先文件名中的 14 位时间串，其次文件最后修改时间。
 * .bz2 压缩文件按内容魔数 BZh 判断，先在 Worker 里解压再识别格式。
 *
 * @param file      用户选择的文件
 * @param productId 产品代码（决定单位与合成兜底峰值）
 * @returns 基数据体（volume）或单层网格（grid），二者必有其一
 * @throws UploadFileError：文件过大 / 解压失败 / 格式不符
 */
export async function parseUploadedFile(
  file: File,
  productId: string
): Promise<UploadedRadarData> {
  // 先卡体积再读文件：arrayBuffer 会把整个文件读进内存，超大文件会直接 OOM
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadFileError(
      'size',
      `文件过大（${(file.size / 1024 / 1024).toFixed(0)}MB），上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`
    );
  }
  let buf = await file.arrayBuffer();
  const product = findProduct(productId);

  // —— .bz2 压缩文件：按内容魔数 BZh 判断（不依赖扩展名），Worker 解压后再识别 ——
  if (isBzip2Data(buf)) {
    try {
      buf = await runDecode('decompress', buf);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new UploadFileError('decode', 'bzip2 解压失败：' + reason);
    }
  }

  // —— 时刻：优先文件名中的 14 位时间串，其次文件最后修改时间 ——
  // 两种来源都统一经 utils/datetime 转成平台 ISO 串，避免格式漂移
  const m = file.name.match(/(\d{14})/);
  const time = m ? digits14ToISO(m[1]) : msToISO(file.lastModified);
  const station = file.name.match(/_I_(Z[A-Z0-9]+)_/);
  const meta: RadarFileMeta = {
    file: file.name,
    binFile: file.name,
    time,
    stationId: station?.[1] ?? '',
    stationName: station?.[1] ?? '',
    hasData: true,
    format: 'rstm' // 实际格式由 parseRadarBuffer 按内容识别
  };

  // strict=true：魔数不认识 → null → 提示格式不符（不回退文件名推断）
  const parsed = await runDecode('parseAny', { buffer: buf, meta, product, strict: true });
  if (!parsed) {
    throw new UploadFileError(
      'format',
      '文件格式不符合预设（支持：SWAN 拼图 / CINRAD RSTM / MICAPS m4）'
    );
  }
  return parsed;
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

/* ───────────────── 下载 / 解压 / 解析 ───────────────── */

/**
 * 下载并解压一个雷达文件（不解析）。
 *
 * 404 / 非 2xx / 解压失败都转成带文件名与原因的 Error；
 * 404 单独抛 RadarFileMissingError，供 UI 提示“该时次无数据”。
 * bz2 解压在 Worker 里执行（数百 ms~1s 的同步热点不再阻塞 UI）。
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

  // 雷达基数据常以 .bin.bz2 分发，Worker 内用 seek-bzip 解压后再解析。
  // 解压后 buf 就是原始基数据，后续格式识别与未压缩文件完全一致。
  if (meta.compressed || /\.bz2$/i.test(meta.binFile)) {
    if (!isBzip2Data(buf)) {
      throw new Error(meta.binFile + ' 不是有效的 bzip2 文件');
    }
    try {
      buf = await runDecode('decompress', buf, signal);
    } catch (e) {
      // 主动取消必须原样抛出：UI 据此保留旧画面，不提示“加载失败”
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(meta.binFile + ' bzip2 解压失败：' + reason);
    }
  }

  return buf;
}

/**
 * 下载并解析 RSTM 基数据体（不含缓存）。
 *
 * 流程：fetch（必要时 Worker 解压）→ Worker parseRstmVolume（结构校验 + 解析）。
 * 非标准体：Worker 把已解压 buffer 一并回传，暂存供回退的 loadGrid 复用，
 * 避免二次下载/解压（与改造前语义一致）。
 *
 * @returns RstmVolume；文件不是基数据体格式时返回 null（不抛错）
 */
export async function loadVolume(
  meta: RadarFileMeta,
  signal?: AbortSignal
): Promise<RstmVolume | null> {
  const buf = await fetchAndDecompress(meta, signal);
  const { volume, buffer } = await runDecode('parseVolume', { buffer: buf, meta }, signal);
  if (!volume) rememberFallbackBuffer(meta.binFile, buffer);
  return volume;
}

/**
 * 下载 + 解析为雷达网格（不含缓存）。
 *
 * 流程：取二进制（优先复用体数据失败 buffer）→ Worker 内格式识别 + 分派解析器。
 * 产品元信息由主线程查好传入（Worker 内没有服务器产品目录）。
 */
export async function loadGrid(
  meta: RadarFileMeta,
  productId: string,
  signal?: AbortSignal
): Promise<RadarGrid> {
  const product = findProduct(productId);

  if (signal?.aborted) throw abortError();
  const buf = takeFallbackBuffer(meta.binFile) ?? (await fetchAndDecompress(meta, signal));

  return runDecode('parseGrid', { buffer: buf, meta, product }, signal);
}