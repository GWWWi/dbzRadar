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
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error('加载清单 ' + url + ' 失败：HTTP ' + resp.status);
  }
  const list = (await resp.json()) as RadarFileMeta[];
  // 双保险：确保按时间升序（时间轴顺序依赖）
  return list.sort((a, b) => (a.time < b.time ? -1 : 1));
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

/**
 * 获取某个文件、某个产品对应的雷达网格（核心取数方法）。
 *
 * 流程：fetch 解压后的二进制 → 格式识别 → 分派解析器 → RadarGrid。
 *
 * @param meta      文件清单项
 * @param productId 产品代码（如 'Z' 基本反射率），决定单位与兜底峰值
 * @returns 解析后的网格（永远返回合法结果：解析失败时内部合成兜底）
 */
export async function fetchRadarGrid(
  meta: RadarFileMeta,
  productId: string
): Promise<RadarGrid> {
  // 产品元信息：用于合成兜底的峰值/单位标注
  const product = findProduct(productId);

  // —— 1) 拉取文件二进制（清单模式为 data/ 下文件名；模板模式为构造出的完整地址） ——
  const url = resolveDataUrl(meta.binFile);
  const resp = await fetch(url);
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
  } else if (meta.format === 'mosaic' || isRADAMOSAIC(buf)) {
    // SWAN 雷达三维拼图：取默认高度层的反射率
    grid = parseRADAMOSAIC(buf, { time: meta.time, product });
  } else {
    // CINRAD 单站 RSTM（含合成兜底，永不抛错）
    grid = parseRSTM(buf, {
      time: meta.time,
      product,
      stationId: meta.stationId,
      stationName: meta.stationName
    });
  }

  // —— 3) 以清单时间为准（文件名时间最可靠） ——
  grid.time = meta.time || grid.time;
  return grid;
}
