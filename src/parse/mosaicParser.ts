/**
 * parse/mosaicParser.ts —— SWAN 雷达三维拼图二进制解析
 *
 * 对应测试数据：Z_OTHE_RADAMOSAIC_20220412000000.bin（中国气象局气象探测中心
 * SWAN 系统雷达三维拼图产品，头部以 ASCII "diamond" 开头，即 MICAPS 131 类
 * 二进制变体 / 3DREF 格式）。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 文件结构（小端字节序，已用真实文件实测验证）：
 *
 *   头部（固定 1024 字节）：
 *     偏移 0   : ASCII "diamond"（12 字节）
 *     偏移 12  : 描述串（38 字节）
 *     偏移 50  : "SWAN"（8 字节）
 *     偏移 58  : 版本串（8 字节）
 *     偏移 66  : int16 年        偏移 68 : int16 月       偏移 70 : int16 日
 *     偏移 72  : int16 时(UTC)   偏移 74 : int16 分
 *     偏移 78  : uint16 经度格点数 X（实测 1400）
 *     偏移 80  : uint16 纬度格点数 Y（实测 1200）
 *     偏移 82  : uint16 高度层数 Z（实测 21 —— 体拼图！）
 *     偏移 84  : int32  参与拼图的雷达站数
 *     偏移 88  : float32 起始经度（100°E，西端）
 *     偏移 92  : float32 起始纬度（35°N，第 0 行 = 北端）
 *     偏移 96  : float32 中心经度   偏移 100 : float32 中心纬度
 *     偏移 104 : float32 经度格距 0.01°   偏移 108 : float32 纬度格距 0.01°
 *     （其后为各层高度表与填充，数据区从偏移 1024 开始）
 *
 *   数据区：X × Y × Z 个采样，行优先、层间连续。每样本字节数由
 *   “剩余字节数 ÷ 总采样数”推断：
 *     · 1 字节 → UInt8，缺测 = 255，物理值 dBZ = (原始值 − 66) × 0.5
 *                （对应 QE GridData 的 algo=2：value = (raw + offset) × scale）
 *     · 2 字节 → Int16，缺测 = 9999，物理值 = 原始值
 *
 * 输出约定：本平台主要显示反射率，这里取体数据中的某一层（默认第 2 层，
 * 约 1.5km CAP 层，与 QuickEarth 官网示例一致——最低层常因波束几何而破碎，
 * 第 2 层回波形态最完整），解码为 dBZ 物理值平面网格。
 * ────────────────────────────────────────────────────────────────────────
 */

import type { RadarGrid, RadarProduct } from '../types';
// 缺测哨兵统一由 constants 提供
import { UNDEF } from '../constants';

/** 头部字节数 */
const HDR_BYTES = 1024;

/* 头部字段偏移（小端） */
const OFF_YEAR = 66;      // int16 年
const OFF_MONTH = 68;     // int16 月
const OFF_DAY = 70;       // int16 日
const OFF_HOUR = 72;      // int16 时（UTC）
const OFF_MINUTE = 74;    // int16 分
const OFF_X_NUM = 78;     // uint16 经度格点数
const OFF_Y_NUM = 80;     // uint16 纬度格点数
const OFF_Z_NUM = 82;     // uint16 高度层数
const OFF_START_LON = 88; // float32 起始经度（西端）
const OFF_START_LAT = 92; // float32 起始纬度（北端，第 0 行）
const OFF_CENTER_LON = 96;
const OFF_CENTER_LAT = 100;
const OFF_X_RESO = 104;   // float32 经度格距
const OFF_Y_RESO = 108;   // float32 纬度格距

/** 缺省渲染的高度层序号：0=0.5km、1=1.0km、2=1.5km（CAP 层最完整） */
const DEFAULT_LAYER_INDEX = 2;

/** mosaic 解析可选参数 */
export interface MosaicParseOptions {
  /** 观测时刻 ISO 串；不给则从头部的年月日时分推导北京时间 */
  time?: string;
  /** 当前产品（决定单位标注） */
  product?: RadarProduct;
  /** 高度层序号（0 起），缺省取 DEFAULT_LAYER_INDEX */
  layerIndex?: number;
}

/**
 * 判断缓冲区是否为 SWAN 雷达拼图：头部以 ASCII "diamond" 开头即可认定。
 * @param buffer 文件二进制
 */
export function isRADAMOSAIC(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 16) return false;
  const head = new Uint8Array(buffer, 0, 7);
  return String.fromCharCode(...head) === 'diamond';
}

/**
 * 主解析入口：把 SWAN 拼图 .bin 解析为单高度层的反射率平面网格 RadarGrid。
 *
 * @param buffer 拼图文件二进制
 * @param opts 可选：time / product / layerIndex
 * @returns 解析结果（真实体数据中的某一层）
 * @throws 头部非法或数据区不足时抛错（调用方可捕获后走合成兜底）
 */
export function parseRADAMOSAIC(
  buffer: ArrayBuffer,
  opts: MosaicParseOptions = {}
): RadarGrid {
  const dv = new DataView(buffer);
  const product = opts.product;
  const productId = product ? product.id : 'Z';
  const units = product ? product.unit : 'dBZ';

  // —— 1) 读取头部数值字段（全部小端） ——
  const year = dv.getInt16(OFF_YEAR, true);
  const month = dv.getInt16(OFF_MONTH, true);
  const day = dv.getInt16(OFF_DAY, true);
  const hour = dv.getInt16(OFF_HOUR, true);
  const minute = dv.getInt16(OFF_MINUTE, true);

  const xNum = dv.getUint16(OFF_X_NUM, true);          // 列数
  const yNum = dv.getUint16(OFF_Y_NUM, true);          // 行数
  const zNum = Math.max(1, dv.getUint16(OFF_Z_NUM, true)); // 层数
  const startLon = dv.getFloat32(OFF_START_LON, true); // 西端经度
  const startLat = dv.getFloat32(OFF_START_LAT, true); // 北端纬度（第 0 行）
  const centerLon = dv.getFloat32(OFF_CENTER_LON, true);
  const centerLat = dv.getFloat32(OFF_CENTER_LAT, true);
  const xReso = dv.getFloat32(OFF_X_RESO, true);
  const yReso = dv.getFloat32(OFF_Y_RESO, true);

  if (!(xNum > 0 && yNum > 0 && xReso > 0 && yReso > 0)) {
    throw new Error(
      'RADAMOSAIC 头部非法：xNum=' + xNum + ' yNum=' + yNum +
      ' xReso=' + xReso + ' yReso=' + yReso
    );
  }

  // —— 2) 观测时刻：头部为 UTC，转成北京时间（UTC+8）的 ISO 串 ——
  let time = opts.time || '';
  if (!time && year > 0) {
    const d = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    d.setUTCHours(d.getUTCHours() + 8);
    const p = (n: number) => String(n).padStart(2, '0');
    time =
      d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
      'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
  }

  // —— 3) 定位数据区并推断每样本字节数（1 或 2） ——
  const plane = xNum * yNum;            // 单层样本数
  const total = plane * zNum;           // 全部样本数
  const dataLen = buffer.byteLength - HDR_BYTES;
  if (dataLen < total) {
    throw new Error(
      'RADAMOSAIC 数据区不足：需要 ' + total + ' 字节，实际 ' + dataLen
    );
  }
  const bytesPerValue = Math.floor(dataLen / total);

  let raw: Uint8Array | Int16Array;
  let rawUndef: number; // 文件内的缺测值表示
  let scale: number;    // 物理值 = (raw + offset) * scale
  let offset: number;
  if (bytesPerValue === 1) {
    raw = new Uint8Array(buffer, HDR_BYTES, total);
    rawUndef = 255;   // 单字节缺测
    scale = 0.5;      // dBZ = (原始值 − 66) × 0.5
    offset = -66;
  } else if (bytesPerValue === 2) {
    // 注意：HDR_BYTES=1024 可被 2 整除，Int16Array 视图对齐安全
    raw = new Int16Array(buffer, HDR_BYTES, total);
    rawUndef = 9999;  // 双字节缺测
    scale = 1;
    offset = 0;
  } else {
    throw new Error('RADAMOSAIC 不支持的样本字节数：' + bytesPerValue);
  }

  // —— 4) 取指定高度层，并把原始码值解码为 dBZ 物理值 ——
  const zi = Math.min(Math.max(opts.layerIndex ?? DEFAULT_LAYER_INDEX, 0), zNum - 1);
  const base = zi * plane;
  const n = plane;
  // 用 Float32Array 承载 168 万点（比 number[] 省一半堆内存），与渲染层类型一致
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = raw[base + i];
    data[i] = v === rawUndef ? UNDEF : (v + offset) * scale;
  }

  return {
    stationId: 'RADAMOSAIC',
    stationName: 'SWAN雷达拼图',
    lat: centerLat,
    lon: centerLon,
    product: productId,
    time,
    units,
    undef: UNDEF,
    // 地理参考直接取自头部：第 0 行 = 北端（yDelta 为负），列方向自西向东。
    // QuickEarth 原生支持负步长，无需翻转行序。
    xStart: startLon,
    xDelta: xReso,
    xSize: xNum,
    yStart: startLat,
    yDelta: -yReso,
    ySize: yNum,
    data,
    isSynthetic: false
  };
}
