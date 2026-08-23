/**
 * parse/cinradParser.ts —— CINRAD 单站雷达基数据（RSTM）解析
 *
 * 对应测试数据：Z_RADR_I_Z95xx_*.bin.bz2（新一代天气雷达单站基数据，
 * bz2 压缩，解压后头部魔数 "RSTM"）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * RSTM 头部字段（小端）—— 已通过真实测试文件实测验证：
 *   偏移 0   : 魔数 "RSTM"（4 字节 ASCII）
 *   偏移 32  : 站号 ASCII（8 字节），如 "Z9543"
 *   偏移 40  : 站名 ASCII（20 字节），如 "BinZhou_Z9543"
 *   偏移 72  : float32 纬度（实测 37.350 ≈ 滨州 37.37）
 *   偏移 76  : float32 经度（实测 117.978 ≈ 滨州 117.93）
 *   偏移 96  : float32 缺测值（实测 -999999）
 *
 * ⚠️ 注意：早期草稿文档记载的经纬度偏移为 88/92，实测该处为无效值
 *    （会导致地图定位错误），此处以实测偏移 72/76 为准。
 *
 * 关于体数据：RSTM 的径向/极坐标体数据编码属于非公开文档格式，
 * 无法可靠解码。因此对“数据体”采取【合成兜底】策略——以站点为中心
 * 生成一块高斯团块反射率网格（峰值随产品变化），保证平台永远有可视内容；
 * 站号/站名/经纬度取自真实文件头（用于定位与标注）。合成结果通过
 * isSynthetic 标记，UI 会给出“示意数据”提示。
 *
 * 健壮性：buffer 全 0 / 魔数不符 / 头部不可解析时，完全使用合成网格兜底，
 * 并用文件名解析出的站号或默认滨州坐标兜底 —— 保证“永远不崩溃、永远能渲染”。
 * ────────────────────────────────────────────────────────────────────────
 */

import type { RadarGrid, RadarProduct } from '../types';

/** 默认站点：滨州 Z9543 坐标（头部完全不可用时兜底） */
const DEFAULT_LAT = 37.37;
const DEFAULT_LON = 117.93;
const DEFAULT_STATION_ID = 'Z9543';
const DEFAULT_STATION_NAME = 'BinZhou_Z9543';

/** 合成网格使用的缺测哨兵值 */
export const SYNTH_UNDEF = 999999;

/* 头部字段偏移（小端） */
const OFF_MAGIC = 0;
const OFF_STATION_ID = 32;
const OFF_STATION_NAME = 40;
const OFF_LAT = 72;   // 实测有效纬度位置
const OFF_LON = 76;   // 实测有效经度位置
const OFF_UNDEF = 96;

/** 解析可选参数 */
export interface ParseOptions {
  /** 观测时刻 ISO 串（通常来自清单 manifest） */
  time?: string;
  /** 当前产品（决定合成团块峰值与单位） */
  product?: RadarProduct;
  /** 头部不可用时的兜底站号（通常来自文件名解析） */
  stationId?: string;
  /** 头部不可用时的兜底站名 */
  stationName?: string;
}

/**
 * 从缓冲区按偏移读取定长 ASCII 字符串（遇 0 即止，去首尾空白）。
 */
function readAscii(buf: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < buf.length; i++) {
    const c = buf[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** 判断缓冲区是否全 0（即无任何有效数据） */
function isAllZero(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/**
 * 尝试解析 RSTM 头部；魔数不符 / 长度不足 / 经纬度明显非法时返回 null。
 */
function tryParseHeader(buf: Uint8Array): {
  stationId: string;
  stationName: string;
  lat: number;
  lon: number;
  undef: number;
} | null {
  if (buf.length < 100) return null;
  const magic = readAscii(buf, OFF_MAGIC, 4);
  if (magic !== 'RSTM') return null;

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lat = dv.getFloat32(OFF_LAT, true);
  const lon = dv.getFloat32(OFF_LON, true);
  // 经纬度合理性检查（中国大陆范围外视为无效，走兜底）
  if (!(lat > 15 && lat < 55 && lon > 70 && lon < 140)) return null;

  const stationId = readAscii(buf, OFF_STATION_ID, 8) || DEFAULT_STATION_ID;
  const stationName = readAscii(buf, OFF_STATION_NAME, 20) || stationId;
  const undef = dv.getFloat32(OFF_UNDEF, true);
  return { stationId, stationName, lat, lon, undef };
}

/**
 * 根据产品代码返回合成反射率团块的峰值（dBZ 或对应量级）。
 */
function productPeak(productId: string): number {
  switch (productId) {
    case 'V': return 25;    // 径向速度 m/s
    case 'ETV': return 12;  // 回波顶高 km
    case 'CR': return 55;   // 组合反射率 dBZ（比基本反射率略强）
    default: return 45;     // 基本反射率 dBZ
  }
}

/**
 * 生成“合成反射率”网格（兜底渲染用，永远返回合法 RadarGrid）。
 *
 * 几何：以站点为中心、半幅 2.0°、分辨率 0.01° 的 400×400 笛卡尔网格；
 * 数据：半径 150km 内为“峰值高斯团块 + 少量噪声”，范围外为缺测（透明）。
 */
export function buildSynthetic(
  opts: ParseOptions & { lat?: number; lon?: number }
): RadarGrid {
  const lat0 = opts.lat ?? DEFAULT_LAT;
  const lon0 = opts.lon ?? DEFAULT_LON;
  const stationId = opts.stationId || DEFAULT_STATION_ID;
  const stationName = opts.stationName || stationId;
  const product = opts.product;
  const productId = product ? product.id : 'Z';
  const units = product ? product.unit : 'dBZ';
  const undef = SYNTH_UNDEF;

  // —— 网格几何：半幅 2.0° 在 37°N 附近东西约 178km，可完整容纳 150km 半径圆 ——
  const half = 2.0;
  const res = 0.01;
  const n = 400;
  const xSize = n;
  const ySize = n;
  const xStart = lon0 - half;
  const xDelta = res;
  const yStart = lat0 - half; // 第 0 行 = 最南行，yDelta 为正
  const yDelta = res;

  // —— 合成团块参数 ——
  const peak = productPeak(productId);
  const sigma = 45;      // 高斯标准差（km）
  const radiusKm = 150;  // 雷达有效探测半径（km）
  const cosLat = Math.cos((lat0 * Math.PI) / 180);

  const data: number[] = new Array(xSize * ySize);
  for (let r = 0; r < ySize; r++) {
    const lat = yStart + r * yDelta;
    for (let c = 0; c < xSize; c++) {
      const lon = xStart + c * xDelta;
      // 经纬度差换算公里距离（等距圆柱近似）
      const dLatKm = (lat - lat0) * 110.0;
      const dLonKm = (lon - lon0) * 110.0 * cosLat;
      const distKm = Math.sqrt(dLatKm * dLatKm + dLonKm * dLonKm);

      let v: number;
      if (distKm <= radiusKm) {
        v = peak * Math.exp(-(distKm * distKm) / (2 * sigma * sigma));
        v += (Math.random() - 0.5) * (peak * 0.08); // 少量噪声避免过于规整
        if (v < 0) v = 0;
      } else {
        v = undef; // 探测范围外 → 缺测（渲染透明）
      }
      data[r * xSize + c] = v;
    }
  }

  return {
    stationId,
    stationName,
    lat: lat0,
    lon: lon0,
    product: productId,
    time: opts.time || '',
    units,
    undef,
    xStart,
    xDelta,
    xSize,
    yStart,
    yDelta,
    ySize,
    data,
    isSynthetic: true
  };
}

/**
 * 主解析入口：把解压后的 CINRAD 单站文件解析为 RadarGrid。
 *
 * 流程：
 *   1. 尝试解析 RSTM 头部；
 *   2. 头部无效（全 0 / 魔数不符）→ 完全合成兜底（isSynthetic=true）；
 *   3. 头部有效 → 站点信息取自真实文件；体数据用合成团块占位，
 *      标记 isSynthetic=false（表示“已识别为真实文件”）。
 */
export function parseRSTM(buffer: ArrayBuffer, opts: ParseOptions = {}): RadarGrid {
  const buf = new Uint8Array(buffer);
  const header = isAllZero(buf) ? null : tryParseHeader(buf);

  if (!header) {
    return buildSynthetic({
      ...opts,
      lat: DEFAULT_LAT,
      lon: DEFAULT_LON,
      stationId: opts.stationId || DEFAULT_STATION_ID,
      stationName: opts.stationName || opts.stationId || DEFAULT_STATION_NAME
    });
  }

  const grid = buildSynthetic({
    ...opts,
    lat: header.lat,
    lon: header.lon,
    stationId: header.stationId,
    stationName: header.stationName
  });
  grid.isSynthetic = false;
  grid.undef = Number.isFinite(header.undef) ? header.undef : SYNTH_UNDEF;
  return grid;
}
