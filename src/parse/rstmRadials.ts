/**
 * parse/rstmRadials.ts —— CINRAD 标准格式（RSTM V2）二进制解析
 *
 * ★ 格式来源 ★
 *   参考 Python 项目 Radar.DataService 的 radar/rio/STANDARD/structures.py，
 *   即中国气象局《新一代天气雷达基数据格式》（标准格式 V2）：
 *     GENERIC_HEADER(32) → SITE_CONFIGURATION(128) → TASK_CONFIGURATION(256)
 *     → CUT_CONFIGURATION × N（每个 256B，N = Cut Number，一个 cut = 一次仰角扫描）
 *     → 径向数据：RADIAL_HEADER(64) + Moment Number 个 [MOMENT_HEADER(32) + 数据]
 *
 * ★ 矩（Moment）= 一个字段在一条径向上的距离库序列 ★
 *   MOMENT_HEADER 带 Data Type / Scale / Offset / Bin Length(1=8 位,2=16 位) / Length，
 *   解码公式（与 Python 完全一致）：
 *       value = (code - Offset) / Scale
 *       code <= 4 → 缺测
 *   实测该数据每个径向 7 个矩：dBT(1) / dBZ(2) / ZDR(7) / CC(9) / ΦDP(10) / KDP(11) / SNRH(16)，
 *   另有一半径向带 V(3) / W(4)。
 *
 * ★ 仰角与“圈” ★
 *   VCP21D 任务有 11 个 cut，但只有 9 个唯一仰角（0.5/1.5° 各分“长距离圈 460km、
 *   Nyquist 8.65”和“短距离圈 230km、Nyquist 27.23”两圈）。本模块按唯一仰角组织
 *   9 层，同一仰角同方位保留距离库更多的那个径向（长圈优先，信息更完整）。
 *
 * ★ 解析性能 ★
 *   - 整个文件只创建一个 DataView（旧实现每个 readI32/readF32 都 new 一次）；
 *   - 8 位矩用 Uint8Array 存原始码，避免统一 Uint16 的临时内存翻倍；
 *   - 空字段共享同一个长度 0 的 Float32Array（每条径向不再分配 9 个空数组）；
 *   - 矩类型 → 字段名用预建反向表，避免每个矩遍历 MOMENT_FIELD。
 */
import { tryParseHeader } from './cinradParser';
import { UNDEF } from '../constants';
import type { RstmRadial, RstmVolume } from '../types';

/* ───────────────────────── 结构大小（字节） ───────────────────────── */

const GENERIC_HEADER_SIZE = 32;
const SITE_CONFIGURATION_SIZE = 128;
const TASK_CONFIGURATION_SIZE = 256;
const CUT_CONFIGURATION_SIZE = 256;
const RADIAL_HEADER_SIZE = 64;
const MOMENT_HEADER_SIZE = 32;

/** 文件头总长（GENERIC + SITE + TASK） */
const FILE_HEADER_SIZE =
  GENERIC_HEADER_SIZE + SITE_CONFIGURATION_SIZE + TASK_CONFIGURATION_SIZE;

/* TASK_CONFIGURATION 内偏移 */
const TASK_CUT_NUMBER = 336;

/* CUT_CONFIGURATION 内偏移 */
const CUT_ELEVATION = 24;
const CUT_LOG_RESOLUTION = 44;
const CUT_DOPPLER_RESOLUTION = 48;
const CUT_MAX_RANGE = 52;
const CUT_START_RANGE = 60;
const CUT_NYQUIST = 80;

/* RADIAL_HEADER 内偏移 */
const RADIAL_ELEVATION_NUMBER = 16;
const RADIAL_AZIMUTH = 20;
const RADIAL_ELEVATION = 24;
const RADIAL_SECONDS = 28;
const RADIAL_MICROSECONDS = 32;
const RADIAL_MOMENT_NUMBER = 40;

/* MOMENT_HEADER 内偏移 */
const MOMENT_DATA_TYPE = 0;
const MOMENT_SCALE = 4;
const MOMENT_OFFSET = 8;
const MOMENT_BIN_LENGTH = 12;
const MOMENT_LENGTH = 16;

/**
 * 矩类型 → 字段名（标准格式 data_type 表，structures.py）。
 * 只列本项目用到的 8 个产品字段 + ΦDP（数据里存在，可作调试参考）。
 */
export const MOMENT_FIELD = {
  dBT: 1, // 滤波前反射率（Total Reflectivity）
  dBZ: 2, // 滤波后反射率（Reflectivity）
  V: 3, // 径向速度（Doppler Velocity）
  W: 4, // 谱宽（Spectrum Width）
  ZDR: 7, // 差分反射率（Differential Reflectivity）
  CC: 9, // 协相关系数（Cross Correlation Coefficient）
  PHIDP: 10, // 差分相移（Differential Phase）
  KDP: 11, // 差分相移率（Specific Differential Phase）
  SNRH: 16 // 水平通道信噪比（Horizontal Signal Noise Ratio）
} as const;

/** 字段名（RstmField）：解析结果与产品代码共用同一套名字 */
export type RstmField = keyof typeof MOMENT_FIELD;

/** 矩类型 → 字段名的反向表（启动时建一次） */
const FIELD_BY_TYPE: Record<number, RstmField> = {};
for (const [name, type] of Object.entries(MOMENT_FIELD)) {
  FIELD_BY_TYPE[type] = name as RstmField;
}

/** 缺测码值阈值：code <= 4 视为缺测（与 Python 的 td <= 4 一致） */
const UNDEF_CODE = 4;

/** cut 数量上限（防御性）：标准格式最多 32 个 cut */
const MAX_CUTS = 32;

/** 空字段共享数组：parser 只会把有数据的字段替换为新数组，空数组不会被写入 */
const EMPTY_FIELD = new Float32Array(0);

/* ───────────────────────── 解析入口 ───────────────────────── */

/**
 * 解析 CINRAD 标准格式基数据体。
 *
 * @param buffer 解压后的二进制（.bz2 需先解压）
 * @returns RstmVolume；不是标准格式 / 结构损坏时返回 null（调用方回退合成网格）
 */
export function parseRstmVolume(buffer: ArrayBuffer): RstmVolume | null {
  const buf = new Uint8Array(buffer);
  // 整个解析只创建一个 DataView：旧实现每次 readI32/readF32 都 new 一次，
  // 36MB 文件解析会产生几十万次临时对象分配。
  const dv = new DataView(buffer);
  if (buf.length < FILE_HEADER_SIZE + RADIAL_HEADER_SIZE) return null;

  // —— 1) 通用头 + 站点 + 任务配置 ——
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== 'RSTM') return null;
  const majorVersion = readU16(buf, 4);
  if (majorVersion !== 2) return null; // 只支持标准格式 V2

  const cutNumber = readI32(dv, TASK_CUT_NUMBER);
  if (!(cutNumber > 0 && cutNumber <= MAX_CUTS)) return null;

  // 站点信息（复用 cinradParser 的头部读取：偏移与 SITE_CONFIGURATION 一致）
  const header = tryParseHeader(buf);

  // —— 2) cut 配置（一个 cut = 一次仰角扫描）——
  interface CutInfo {
    elevation: number;
    gateSize: number;
    startRange: number;
    maxRange: number;
    nyquist: number;
  }
  const cuts: CutInfo[] = [];
  for (let i = 0; i < cutNumber; i++) {
    const c = FILE_HEADER_SIZE + i * CUT_CONFIGURATION_SIZE;
    if (c + CUT_CONFIGURATION_SIZE > buf.length) return null;

    const gateSize = readI32(dv, c + CUT_LOG_RESOLUTION);
    if (!(gateSize > 0 && gateSize < 100000)) return null;

    const maxRange = readI32(dv, c + CUT_MAX_RANGE);
    cuts.push({
      elevation: readF32(dv, c + CUT_ELEVATION),
      gateSize,
      startRange: Math.max(0, readI32(dv, c + CUT_START_RANGE)),
      maxRange: maxRange > 0 && maxRange < 2_000_000 ? maxRange : gateSize * 2000,
      nyquist: readF32(dv, c + CUT_NYQUIST)
    });
  }

  // —— 3) 逐径向 + 逐矩解析 ——
  // 同一仰角可能对应多个 cut（长短圈）：用“方位角 → 径向”映射合并，
  // 同一方位保留距离库更多的那个（长距离圈优先）。
  interface LayerAcc {
    elevation: number;
    gateSize: number;
    startRange: number;
    maxRange: number;
    nyquist: number;
    /** 方位角（保留 3 位小数）→ 径向；只用于去重，最终按方位升序转数组 */
    byAzimuth: Map<string, RstmRadial>;
  }

  const layerMap = new Map<number, LayerAcc>(); // key = 唯一仰角 × 100 取整
  let pos = FILE_HEADER_SIZE + cutNumber * CUT_CONFIGURATION_SIZE;
  const end = buf.length;
  let parsed = 0;

  while (pos + RADIAL_HEADER_SIZE <= end) {
    const elevationNumber = readI32(dv, pos + RADIAL_ELEVATION_NUMBER);
    const momentNumber = readI32(dv, pos + RADIAL_MOMENT_NUMBER);
    // 结构性错误（越界的编号/矩数）→ 停止，已解析部分仍可使用
    if (!(elevationNumber >= 1 && elevationNumber <= cutNumber)) break;
    if (!(momentNumber >= 0 && momentNumber <= 32)) break;

    const cut = cuts[elevationNumber - 1];
    const azimuth = readF32(dv, pos + RADIAL_AZIMUTH);
    const elevation = readF32(dv, pos + RADIAL_ELEVATION);
    const seconds = readI32(dv, pos + RADIAL_SECONDS);
    const microseconds = readI32(dv, pos + RADIAL_MICROSECONDS);

    // 逐矩读取：每个矩 = MOMENT_HEADER + 数据
    let mp = pos + RADIAL_HEADER_SIZE;
    let valid = true;
    /** 本径向各字段的原始数据（未解码）与解码参数 */
    const raw = new Map<
      RstmField,
      { codes: Uint8Array | Uint16Array; scale: number; offset: number }
    >();

    for (let m = 0; m < momentNumber; m++) {
      if (mp + MOMENT_HEADER_SIZE > end) {
        valid = false;
        break;
      }
      const dataType = readI32(dv, mp + MOMENT_DATA_TYPE);
      const scale = readI32(dv, mp + MOMENT_SCALE);
      const offset = readI32(dv, mp + MOMENT_OFFSET);
      const binLength = readI16(buf, mp + MOMENT_BIN_LENGTH);
      const length = readI32(dv, mp + MOMENT_LENGTH);

      if (length < 0 || mp + MOMENT_HEADER_SIZE + length > end) {
        valid = false;
        break;
      }

      const field = fieldOfMoment(dataType);
      if (field && scale > 0 && (binLength === 1 || binLength === 2)) {
        const count = Math.floor(length / binLength);
        // 8 位矩用 Uint8Array：临时码数组内存减半（长圈 1840 库 × 9 矩）
        const codes = binLength === 1 ? new Uint8Array(count) : new Uint16Array(count);
        if (binLength === 1) {
          for (let i = 0; i < count; i++) codes[i] = buf[mp + MOMENT_HEADER_SIZE + i];
        } else {
          for (let i = 0; i < count; i++) {
            codes[i] = dv.getUint16(mp + MOMENT_HEADER_SIZE + i * 2, true);
          }
        }
        raw.set(field, { codes, scale, offset });
      }

      mp += MOMENT_HEADER_SIZE + length;
    }

    if (!valid) break; // 数据损坏：丢弃后续（已解析部分保留）

    // 组装为解码后的字段数组（缺测 = UNDEF）
    const fields = emptyFields();
    let maxBins = 0;
    for (const [name, r] of raw) {
      const out = new Float32Array(r.codes.length).fill(UNDEF);
      for (let i = 0; i < r.codes.length; i++) {
        const code = r.codes[i];
        if (code > UNDEF_CODE) out[i] = (code - r.offset) / r.scale;
      }
      // ★ 径向速度按奈奎斯特速度折叠（dealias）★
      //   原始编码 (code-129)/2 的覆盖范围约 ±64.5 m/s，而实际可测速度只有
      //   ±Nyquist（0.5° 短圈 27.23、高仰角 31.72）。超出部分会“折回来”，
      //   不解折叠的话图上会出现大量 ±30~60 的假速度，色标只到 ±30，
      //   表现为颜色混乱、相邻格跳变。
      //   服务端 m4 产品的 V 值域恰好是 ±27（=Nyquist），证明其做过折叠。
      if (name === 'V' && cut.nyquist > 0 && out.length > 0) {
        const span = 2 * cut.nyquist;
        for (let i = 0; i < out.length; i++) {
          const v = out[i];
          if (v === UNDEF) continue;
          // 把 v 映射到 [-nyquist, nyquist)
          out[i] = ((((v + cut.nyquist) % span) + span) % span) - cut.nyquist;
        }
      }
      fields[name] = out;
      if (out.length > maxBins) maxBins = out.length;
    }

    if (maxBins > 0) {
      const radial: RstmRadial = {
        azimuth,
        elevation,
        nyquist: cut.nyquist,
        seconds,
        microseconds,
        fields
      };
      const key = Math.round(cut.elevation * 100);
      let acc = layerMap.get(key);
      if (!acc) {
        acc = {
          elevation: cut.elevation,
          gateSize: cut.gateSize,
          startRange: cut.startRange,
          maxRange: cut.maxRange,
          nyquist: cut.nyquist,
          byAzimuth: new Map()
        };
        layerMap.set(key, acc);
      }
      // ★ 保留精确方位（不再量化到 1°）★
      //
      // 原始每圈 363~368 条径向，步长 0.98°/0.99°。量化到 1° 会让同一物理点
      // 在我们与极坐标视图（及服务端 m4）之间落到相邻格 —— 实测 30km 处
      // 1° 方位只跨 0.5km，而径向分辨率是 250m，速度梯度大时同点差可达 5 m/s 以上。
      // 因此这里把长短圈的全部径向都保留（约 731 条/层），按方位升序排列，
      // 取样时再按“字段”找最近的、该字段有值的径向（见 findNearestRadial）——
      // 长圈有 460km 的反射率但没有 V/W，短圈有 V/W 但只到 230km，
      // 只有分开找才能两者都拿到。
      const azKey = azimuth.toFixed(3);
      if (!acc.byAzimuth.has(azKey)) acc.byAzimuth.set(azKey, radial);
    }

    parsed++;
    pos = mp;
  }

  if (parsed === 0 || layerMap.size === 0) return null;

  // —— 4) 按唯一仰角组织层，方位角升序（便于二分查找） ——
  const layers: RstmRadial[][] = [];
  const elevations: number[] = [];
  const gateSizes: number[] = [];
  const startRanges: number[] = [];
  const maxRanges: number[] = [];
  const nyquists: number[] = [];
  let gateSize = cuts[0].gateSize;

  for (const acc of [...layerMap.values()].sort((a, b) => a.elevation - b.elevation)) {
    const radials = [...acc.byAzimuth.values()].sort((a, b) => a.azimuth - b.azimuth);
    if (radials.length === 0) continue;
    layers.push(radials);
    elevations.push(acc.elevation);
    gateSizes.push(acc.gateSize);
    startRanges.push(acc.startRange);
    maxRanges.push(acc.maxRange);
    // 层的奈奎斯特速度以“V/W 实际来源的那一圈”为准：
    // 长圈（460km）是 8.65，短圈（230km）是 27.23，口径用错会让速度量程标注失真
    const dopplerRadial = radials.find((r) => r.fields.V.length > 0) ?? radials[0];
    nyquists.push(dopplerRadial.nyquist);
    gateSize = acc.gateSize;
  }

  // 观测时刻：取第一个径向的时间（Unix 秒，见 secondsToISO 说明）
  const first = layers[0][0];
  const time = secondsToISO(first.seconds, first.microseconds);

  return {
    stationId: header?.stationId ?? 'Z0000',
    stationName: header?.stationName ?? 'Z0000',
    lat: header?.lat ?? 0,
    lon: header?.lon ?? 0,
    time,
    gateSize,
    gateCounts: layers.map((l) => Math.max(0, ...l.map((r) => r.fields.dBZ.length))),
    gateSizes,
    startRanges,
    maxRanges,
    nyquists,
    elevations,
    layers
  };
}

/** 矩类型 → 字段名（不认识的类型返回 null） */
function fieldOfMoment(dataType: number): RstmField | null {
  return FIELD_BY_TYPE[dataType] ?? null;
}

/** 构造字段容器：空字段共享同一个零长数组，避免每条径向分配 9 个空数组 */
function emptyFields(): RstmRadial['fields'] {
  return {
    dBT: EMPTY_FIELD,
    dBZ: EMPTY_FIELD,
    V: EMPTY_FIELD,
    W: EMPTY_FIELD,
    ZDR: EMPTY_FIELD,
    CC: EMPTY_FIELD,
    KDP: EMPTY_FIELD,
    SNRH: EMPTY_FIELD,
    PHIDP: EMPTY_FIELD
  };
}

/**
 * 径向时间（RADIAL_HEADER.Seconds）→ ISO 串。
 *
 * ★ 基准是 1970-01-01（Unix 时间戳），不是 Python 项目里的 1971-01-01 ★
 *   实测该数据源的 Seconds 与文件名时刻按 Unix 基准完全吻合
 *   （如 Seconds≈1792281691 ↔ 文件名 20261018000131）；
 *   若按 1971 基准换算会整体偏一年，因此这里用 Unix 基准。
 */
function secondsToISO(seconds: number, microseconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const d = new Date((seconds + microseconds / 1e6) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/* ───────────────────────── 小工具 ───────────────────────── */

function readU16(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readI16(buf: Uint8Array, offset: number): number {
  const v = readU16(buf, offset);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function readI32(dv: DataView, offset: number): number {
  return dv.getInt32(offset, true);
}

function readF32(dv: DataView, offset: number): number {
  return dv.getFloat32(offset, true);
}
