/**
 * parse/micapsM4Parser.ts —— MICAPS 第 4 类格点数据（.m4）解析
 *
 * 对应测试数据：*.m4 文本文件（MICAPS Diamond 4，格点等值线数据）。
 * 格式规范（参考 MICAPS 官方文档 / 博客园 lion_yiss《MICAPS数据文件格式》）：
 *
 * ────────────────────────────────────────────────────────────────────────
 * 文件头：
 *   diamond 4 数据说明（字符串） 年 月 日 时次 时效 层次（均为整数）
 *   经度格距 纬度格距 起始经度 终止经度 起始纬度 终止纬度（均为浮点数）
 *   纬向格点数 经向格点数（均为整数）
 *   等值线间隔 等值线起始值 等值线终止值 平滑系数 加粗线值（均为浮点数）
 *
 * 数据体：
 *   按先纬向后经向存放（即行优先：先第 0 行的所有列，再下一行），
 *   均为浮点数；缺测值用 9999 表示。
 *
 * 地理对应关系：
 *   - xStart = 起始经度（第 1 个数据的经度），xDelta = 经度格距
 *   - yStart = 起始纬度（第 1 行的纬度），yDelta = 纬度格距
 *     （常规 MICAPS 文件纬度格距为负 → 第 0 行为最北行；QE 原生支持负步长，
 *      因此无需翻转行序，直接透传即可）
 * ────────────────────────────────────────────────────────────────────────
 */

import type { RadarGrid, RadarProduct } from '../types';
// 平台缺测哨兵由 constants 提供
import { UNDEF } from '../constants';

/** MICAPS 文件内的缺测值（解析时映射为平台哨兵 UNDEF） */
export const M4_UNDEF_RAW = 9999;

/** 文件头中位于“数据说明”之后的数值字段个数（19 个） */
const HEADER_NUM_COUNT = 19;

/**
 * 解析文本为 token 数组。
 * 说明：MICAPS 的“数据说明”是含空格的中文串且编码常为 GBK，
 * 但其后的头/体数据全部是 ASCII 数字，因此这里只把【第一行】单独处理，
 * 其余内容按空白切分即可，天然兼容 GBK/UTF-8 编码差异。
 */
function tokenize(text: string): string[] {
  return text.trim().split(/\s+/);
}

/**
 * 判断文本是否为 MICAPS diamond 4 文件。
 */
export function isMicapsM4(text: string): boolean {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const t = tokenize(firstLine.replace(/[^\x20-\x7E]+.*$/, (m) => ' ')); // 截去中文描述
  return t[0] === 'diamond' && t[1] === '4';
}

/**
 * 主解析入口：把 MICAPS diamond 4 文本解析为 RadarGrid。
 *
 * @param text   文件全文（字符串）
 * @param opts   可选：product（决定产品代码与单位）、fallbackTime（头部缺年月日时兜底）
 * @returns 解析结果
 * @throws 头部字段不足 / 数据量不足时抛错
 */
export function parseMicapsM4(
  text: string,
  opts: { product?: RadarProduct; fallbackTime?: string } = {}
): RadarGrid {
  const lines = text.split(/\r?\n/);

  // —— 1) 第一行："diamond 4 <数据说明...>"，说明可能含空格，取整行剩余部分 ——
  const firstLine = (lines.shift() || '').trim();
  if (!/^diamond\s+4(\s|$)/.test(firstLine)) {
    throw new Error('不是合法的 MICAPS 第 4 类文件：' + firstLine.slice(0, 40));
  }
  const description = firstLine.replace(/^diamond\s+4\s*/, '').trim() || 'MICAPS格点';

  // —— 2) 把剩余所有行的数值 token 全部收集（m4 为纯文本，体量小，全量切分开销可忽略）——
  // 注意：不能在读到 19 个后就停止，否则会丢失后续的数据体 token。
  const tokens: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    for (const tk of line.split(/\s+/)) {
      if (tk !== '') tokens.push(tk);
    }
  }
  if (tokens.length < HEADER_NUM_COUNT) {
    throw new Error('M4 头部字段不足：期望 19 个，实际 ' + tokens.length);
  }
  const nums = tokens.slice(0, HEADER_NUM_COUNT).map(Number);

  const yearRaw = Math.trunc(nums[0]);
  const month = Math.trunc(nums[1]);
  const day = Math.trunc(nums[2]);
  const hour = Math.trunc(nums[3]);

  const lonDelta = nums[6];        // 经度格距
  const latDelta = nums[7];        // 纬度格距（常为负）
  const startLon = nums[8];        // 起始经度
  const startLat = nums[10];       // 起始纬度
  const xSize = Math.trunc(nums[12]); // 纬向格点数 = 列数
  const ySize = Math.trunc(nums[13]); // 经向格点数 = 行数

  if (!(xSize > 0 && ySize > 0 && lonDelta > 0 && latDelta !== 0 &&
        Number.isFinite(startLon) && Number.isFinite(startLat))) {
    throw new Error(
      'M4 头部非法：xSize=' + xSize + ' ySize=' + ySize +
      ' lonDelta=' + lonDelta + ' latDelta=' + latDelta
    );
  }

  // —— 3) 观测时刻：年月日时次 + 时效（时效不计入显示时刻，仅取起报时间）——
  // MICAPS 常用两位年份：<50 视为 20xx，否则 19xx
  let time = opts.fallbackTime || '';
  if (!time) {
    const year = yearRaw < 100 ? (yearRaw < 50 ? 2000 + yearRaw : 1900 + yearRaw) : yearRaw;
    const p = (n: number) => String(n).padStart(2, '0');
    time =
      year + '-' + p(month) + '-' + p(day) +
      'T' + p(hour) + ':00:00';
  }

  // —— 4) 数据体：xSize × ySize 个浮点数，行优先 ——
  const n = xSize * ySize;
  const dataTokens = tokens.slice(HEADER_NUM_COUNT);
  if (dataTokens.length < n) {
    throw new Error(
      'M4 数据不足：需要 ' + n + ' 个值，实际 ' + dataTokens.length
    );
  }
  // Float32Array：与渲染层 GridDataType.Float32 一致，省一半堆内存
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = Number(dataTokens[i]);
    // 缺测(9999)或非法值 → 统一映射为平台缺测哨兵（渲染透明）
    data[i] = Number.isFinite(v) && v !== M4_UNDEF_RAW ? v : UNDEF;
  }

  const product = opts.product;

  return {
    stationId: 'MICAPS_M4',
    stationName: description.slice(0, 30),
    lat: startLat + latDelta * (ySize - 1) / 2, // 网格中心纬度（参考定位用）
    lon: startLon + lonDelta * (xSize - 1) / 2,
    product: product ? product.id : 'Z',
    time,
    units: product ? product.unit : 'dBZ',
    undef: UNDEF,
    xStart: startLon,
    xDelta: lonDelta,
    xSize,
    // 直接透传纬度方向（yDelta 可为负=第0行在最北），QE 两种方向均支持
    yStart: startLat,
    yDelta: latDelta,
    ySize,
    data,
    isSynthetic: false
  };
}
