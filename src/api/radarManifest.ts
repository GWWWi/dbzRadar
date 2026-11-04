/**
 * api/radarManifest.ts —— 雷达文件清单发现与路径解析
 *
 * 职责：
 *   - fetchRadarFileList：配置地址 → 数据服务 manifest → 目录索引扫描 → 本地回退；
 *   - buildFileMetaFromTemplate：模板模式按时刻构造文件清单项；
 *   - resolveDataUrl：把清单里的文件名解析为可 fetch 的完整地址。
 *
 * 本文件只处理“文件在哪里”，不负责下载与解析（见 radarSource.ts）。
 */

import type { RadarFileMeta } from '../types';
import { digits14ToISO } from '../utils/datetime';
import { fetchWithTimeout } from '../utils/http';
import { DATA_BASE_URL } from '../config/dataSource';

/**
 * 把清单中的文件地址解析为可 fetch 的完整地址：
 *   - 绝对 URL / 协议相对 URL → 原样（配置里可直接写服务器地址）
 *   - 含 / 的相对路径（模板构造的文件名）→ 原样
 *   - 纯文件名（目录扫描 / 清单）→ 拼接数据服务基地址
 */
export function resolveDataUrl(binFile: string): string {
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
    format: 'rstm' // 实际格式由 radarSource 的魔数检测兜底纠正
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
 * 取数阶段解压后还会用二进制魔数复核（见 radarSource.detectFormat）。
 */
export function buildMetaFromFileName(name: string): RadarFileMeta | null {
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
      `[radarManifest] 目录中含 ${compressedCount} 个 .bz2 压缩文件，将在浏览器端解压后解析`
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
    console.warn('[radarManifest] 数据服务未提供 manifest.json，改为扫描目录索引：', e);
  }

  try {
    return await scanDataDirectory();
  } catch (e) {
    console.warn('[radarManifest] 目录索引不可用，回退本地 data/manifest.json：', e);
  }

  return loadManifest('data/manifest.json');
}
