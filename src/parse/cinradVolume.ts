/**
 * parse/cinradVolume.ts —— CINRAD 标准格式（RSTM V2）基数据体解析与极坐标取样
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
 * ★ 与旧实现的区别 ★
 *   旧版按“固定 54 字段层 × 45 组 × 8 块”猜结构，且用固定公式解反射率，
 *   与真实 Scale/Offset 不符（实测偏差约 13 dBZ）。现按标准格式逐径向逐矩解析，
 *   每个矩用自己的 Scale/Offset 解码。
 */
import { tryParseHeader } from './cinradParser';
import { UNDEF } from '../constants';
import type { RadarGrid, RstmRadial, RstmSample, RstmVolume } from '../types';

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

/** 缺测码值阈值：code <= 4 视为缺测（与 Python 的 td <= 4 一致） */
const UNDEF_CODE = 4;

/** cut 数量上限（防御性）：标准格式最多 32 个 cut */
const MAX_CUTS = 32;

/** 全部字段名（按字段合并时遍历用） */
const FIELD_NAMES = Object.keys(MOMENT_FIELD) as RstmField[];

/* ───────────────────────── 解析入口 ───────────────────────── */

/**
 * 解析 CINRAD 标准格式基数据体。
 *
 * @param buffer 解压后的二进制（.bz2 需先解压）
 * @returns RstmVolume；不是标准格式 / 结构损坏时返回 null（调用方回退合成网格）
 */
export function parseRstmVolume(buffer: ArrayBuffer): RstmVolume | null {
  const buf = new Uint8Array(buffer);
  if (buf.length < FILE_HEADER_SIZE + RADIAL_HEADER_SIZE) return null;

  // —— 1) 通用头 + 站点 + 任务配置 ——
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== 'RSTM') return null;
  const majorVersion = readU16(buf, 4);
  if (majorVersion !== 2) return null; // 只支持标准格式 V2

  const cutNumber = readI32(buf, TASK_CUT_NUMBER);
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

    const gateSize = readI32(buf, c + CUT_LOG_RESOLUTION);
    if (!(gateSize > 0 && gateSize < 100000)) return null;

    const maxRange = readI32(buf, c + CUT_MAX_RANGE);
    cuts.push({
      elevation: readF32(buf, c + CUT_ELEVATION),
      gateSize,
      startRange: Math.max(0, readI32(buf, c + CUT_START_RANGE)),
      maxRange: maxRange > 0 && maxRange < 2_000_000 ? maxRange : gateSize * 2000,
      nyquist: readF32(buf, c + CUT_NYQUIST)
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
    const elevationNumber = readI32(buf, pos + RADIAL_ELEVATION_NUMBER);
    const momentNumber = readI32(buf, pos + RADIAL_MOMENT_NUMBER);
    // 结构性错误（越界的编号/矩数）→ 停止，已解析部分仍可使用
    if (!(elevationNumber >= 1 && elevationNumber <= cutNumber)) break;
    if (!(momentNumber >= 0 && momentNumber <= 32)) break;

    const cut = cuts[elevationNumber - 1];
    const azimuth = readF32(buf, pos + RADIAL_AZIMUTH);
    const elevation = readF32(buf, pos + RADIAL_ELEVATION);
    const seconds = readI32(buf, pos + RADIAL_SECONDS);
    const microseconds = readI32(buf, pos + RADIAL_MICROSECONDS);

    // 逐矩读取：每个矩 = MOMENT_HEADER + 数据
    let mp = pos + RADIAL_HEADER_SIZE;
    let valid = true;
    /** 本径向各字段的原始数据（未解码）与解码参数 */
    const raw = new Map<RstmField, { codes: Uint8Array | Uint16Array; scale: number; offset: number }>();

    for (let m = 0; m < momentNumber; m++) {
      if (mp + MOMENT_HEADER_SIZE > end) {
        valid = false;
        break;
      }
      const dataType = readI32(buf, mp + MOMENT_DATA_TYPE);
      const scale = readI32(buf, mp + MOMENT_SCALE);
      const offset = readI32(buf, mp + MOMENT_OFFSET);
      const binLength = readI16(buf, mp + MOMENT_BIN_LENGTH);
      const length = readI32(buf, mp + MOMENT_LENGTH);

      if (length < 0 || mp + MOMENT_HEADER_SIZE + length > end) {
        valid = false;
        break;
      }

      const field = fieldOfMoment(dataType);
      if (field && scale > 0 && (binLength === 1 || binLength === 2)) {
        const count = Math.floor(length / binLength);
        const codes = new Uint16Array(count);
        if (binLength === 1) {
          for (let i = 0; i < count; i++) codes[i] = buf[mp + MOMENT_HEADER_SIZE + i];
        } else {
          const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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
  for (const [name, type] of Object.entries(MOMENT_FIELD)) {
    if (type === dataType) return name as RstmField;
  }
  return null;
}

/** 构造全 UNDEF 的字段容器 */
function emptyFields(): RstmRadial['fields'] {
  const empty = () => new Float32Array(0);
  return {
    dBT: empty(),
    dBZ: empty(),
    V: empty(),
    W: empty(),
    ZDR: empty(),
    CC: empty(),
    KDP: empty(),
    SNRH: empty(),
    PHIDP: empty()
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

/* ───────────────────────── 经纬度 → 极坐标取样 ───────────────────────── */

/** 地球平均半径（米） */
const EARTH_RADIUS = 6371000;

/**
 * 经纬度 → 相对雷达站的（方位角, 斜距）。
 *
 * 方位角：正北为 0，顺时针（东为 90）；与 RSTM 的方位定义一致。
 * 斜距：Haversine 公式 —— 比球面余弦定理在小距离下数值稳定。
 */
export function latLonToPolar(
  lat: number,
  lon: number,
  radarLat: number,
  radarLon: number
): { azimuth: number; range: number } {
  const p1 = (radarLat * Math.PI) / 180;
  const p2 = (lat * Math.PI) / 180;
  const dLat = p2 - p1;
  const dLon = ((lon - radarLon) * Math.PI) / 180;

  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  let azimuth = (Math.atan2(y, x) * 180) / Math.PI;
  if (azimuth < 0) azimuth += 360;

  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const range = EARTH_RADIUS * c;

  return { azimuth, range };
}

/**
 * 极坐标（方位角 + 斜距）→ 经纬度。latLonToPolar 的逆运算（球面模型）。
 */
export function polarToLatLon(
  azimuthDeg: number,
  rangeM: number,
  radarLat: number,
  radarLon: number
): { lat: number; lon: number } {
  const delta = rangeM / EARTH_RADIUS;
  const theta = (azimuthDeg * Math.PI) / 180;
  const p1 = (radarLat * Math.PI) / 180;
  const l1 = (radarLon * Math.PI) / 180;

  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(theta)
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(p1),
      Math.cos(delta) - Math.sin(p1) * Math.sin(p2)
    );

  return { lat: (p2 * 180) / Math.PI, lon: (l2 * 180) / Math.PI };
}

/* ─────────────── 地面距离 ↔ 沿波束斜距（4/3 地球半径模型） ─────────────── */

/**
 * 4/3 地球半径（米）：标准大气折射的等效地球模型。
 *
 * 雷达波束在折射大气中近似沿直线传播，用 4/3 倍地球半径的“等效地球”
 * 即可把弯曲波束折算成直线，这是雷达气象的通用近似（Doviak & Zrnić）。
 */
const EFFECTIVE_EARTH_RADIUS = (4 / 3) * EARTH_RADIUS;

/**
 * 斜距（沿波束 s）→ 地面大圆距离（r）。
 *
 * 标准模型：
 *   h = sqrt(s² + (kRe)² + 2·s·kRe·sinθ) − kRe   （波束中心高度）
 *   r = kRe · asin(s·cosθ / (kRe + h))            （地面投影距离）
 *
 * @param slantRange   沿波束斜距（米），即距离库实际测量的距离
 * @param elevationDeg 波束仰角（度）
 */
export function slantToGroundRange(slantRange: number, elevationDeg: number): number {
  if (slantRange <= 0) return Math.max(slantRange, 0);
  const theta = (elevationDeg * Math.PI) / 180;
  const h =
    Math.sqrt(
      slantRange * slantRange +
        EFFECTIVE_EARTH_RADIUS * EFFECTIVE_EARTH_RADIUS +
        2 * slantRange * EFFECTIVE_EARTH_RADIUS * Math.sin(theta)
    ) - EFFECTIVE_EARTH_RADIUS;
  const x = (slantRange * Math.cos(theta)) / (EFFECTIVE_EARTH_RADIUS + h);
  return EFFECTIVE_EARTH_RADIUS * Math.asin(Math.min(1, Math.max(-1, x)));
}

/**
 * 地面大圆距离（r）→ 斜距（沿波束 s）。`slantToGroundRange` 的反解。
 *
 * ★ 为什么必须有这一步 ★
 *   由经纬度算出来的是**地面距离** r，而距离库索引对应的是**沿波束斜距** s。
 *   低仰角两者几乎重合（0.5° 时 460km 差 0.1km ≈ 0.4 个库，可忽略）；
 *   高仰角不能忽略：19.5° 时地面 123km 对应斜距约 131km，
 *   差 8km ≈ 32 个库 —— 不换算会让高仰角层取到的库系统性偏近。
 *
 * 地面距离随斜距单调递增，用二分求解（24 次迭代精度优于 0.1m）。
 *
 * @param groundRange  地面大圆距离（米）
 * @param elevationDeg 波束仰角（度）
 */
export function groundToSlantRange(groundRange: number, elevationDeg: number): number {
  if (groundRange <= 0) return Math.max(groundRange, 0);
  // 斜距恒 ≥ 地面距离（仰角越大差距越大）；本雷达最高仰角 19.5°，
  // 2 倍上界足够覆盖（19.5° 时约 1.07 倍）
  let lo = groundRange;
  let hi = groundRange * 2;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (slantToGroundRange(mid, elevationDeg) < groundRange) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 读取指定经纬度处各字段的数值（极坐标最近邻取样）。
 *
 * 取数口径（4 步）：
 *   1) 经纬度 → 相对雷达的（方位角, 地面距离）；
 *   2) 方位角 → 该字段**有数据**的最近径向（保留原始方位分辨率，
 *      长短圈分别找：长圈 460km 没有 V/W，短圈 230km 才有）；
 *   3) 地面距离按**该径向实际仰角**换算成沿波束斜距，再选最近距离库
 *      （库位置 = StartRange + gateSize×i）；
 *   4) 原始编码换算：(code − Offset) / Scale，code ≤ 4 视为缺测。
 * dBZ 缺测时整体返回 null（无回波处不再返回其它字段），与“图上透明 = 取值空”一致。
 */
export function sampleRstmValue(
  volume: RstmVolume,
  lat: number,
  lon: number,
  layerIdx = 0
): RstmSample | null {
  const li = Math.min(Math.max(layerIdx, 0), volume.layers.length - 1);
  const layer = volume.layers[li];
  if (!layer || layer.length === 0) return null;

  const { azimuth, range } = latLonToPolar(lat, lon, volume.lat, volume.lon);

  // 反射率与“是否无回波”的判定基准：必须有 dBZ 的那条径向
  const zRadial = findNearestRadial(layer, azimuth, 'dBZ');
  if (!zRadial) return null;

  const gateSize = volume.gateSizes[li];
  const startRange = volume.startRanges[li];
  // ★ 第 3 步：地面距离 → 沿波束斜距（按该径向的实际仰角）★
  //   径向头的实际仰角比 cut 标称角更准（如标称 0.5°、实际 0.68°）
  const elevation = zRadial.elevation || volume.elevations[li] || 0;
  const slantRange = groundToSlantRange(range, elevation);
  const gate = Math.floor((slantRange - startRange) / gateSize);
  if (gate < 0 || gate >= zRadial.fields.dBZ.length) return null;

  const z = zRadial.fields.dBZ[gate];
  if (!Number.isFinite(z) || z === UNDEF) return null;

  /** 取某字段的值：该字段单独找最近的、有数据的径向（长短圈各取所长） */
  const pickField = (field: RstmField): number | null => {
    const r = field === 'dBZ' ? zRadial : findNearestRadial(layer, azimuth, field);
    if (!r) return null;
    const v = r.fields[field][gate];
    return v === undefined || !Number.isFinite(v) || v === UNDEF ? null : v;
  };

  return {
    azimuth,
    range,
    elevation: volume.elevations[li],
    nyquist: volume.nyquists[li],
    gate,
    dBT: pickField('dBT'),
    dBZ: z,
    V: pickField('V'),
    W: pickField('W'),
    ZDR: pickField('ZDR'),
    CC: pickField('CC'),
    KDP: pickField('KDP'),
    SNRH: pickField('SNRH'),
    PHIDP: pickField('PHIDP')
  };
}

/* ───────────────── 九点（3×3 邻域）取样 ───────────────── */

/** 九点邻域取样结果 */
export interface RstmNeighborhood {
  /** 中心库的原始值（最近邻，与图上颜色同口径） */
  center: number | null;
  /** 3×3 邻域有效值的平均（含中心）；有效数不足时为 null */
  mean: number | null;
  /** 参与平均的有效库数（0~9） */
  validCount: number;
  /** 邻域内被检查的库数（边界处可能 < 9） */
  totalCount: number;
}

/** 给出均值所需的最少有效库数：太少说明处在数据边缘/空洞，均值不可靠 */
const MIN_NEIGHBORS_FOR_MEAN = 5;

/**
 * 九点（3×3）邻域取样：中心库 + 周围 8 个库（方位 ±1、距离 ±1）。
 *
 * ★ 与 sampleRstmValue 的区别 ★
 *   - sampleRstmValue 是**最近邻单库**取值：保峰值、不平滑，是显示与查询的默认口径；
 *   - 本函数额外给出 3×3 均值，用于抑制斑点噪声、与外部观测做定量对比。
 *
 * ★ 三点注意事项（也是不建议作为默认口径的原因）★
 *   1. **缺测**：只对有效库求平均；有效数 < 5 时不给均值（1~2 个样本不可靠）；
 *   2. **峰值被压低**：反射率强核心（如 55 dBZ）会被邻域弱值拉低，影响强对流判识；
 *   3. **速度是矢量**：这里做的是标量平均，跨零速度线会得到“伪小值”，
 *      仅作参考（严格做法是先分解为 u/v 分量，平均后再投影回径向）。
 *
 * 方位索引在数组内环绕（0° 与 360° 相接）；距离库按数组边界截断。
 *
 * @param volume   解析得到的基数据体
 * @param lat      目标纬度
 * @param lon      目标经度
 * @param layerIdx 仰角层序号
 * @param field    字段名
 * @param radius   邻域半径（默认 1 → 3×3 = 九点）
 */
export function sampleRstmNeighborhood(
  volume: RstmVolume,
  lat: number,
  lon: number,
  layerIdx: number,
  field: RstmField,
  radius = 1
): RstmNeighborhood | null {
  const li = Math.min(Math.max(layerIdx, 0), volume.layers.length - 1);
  const layer = volume.layers[li];
  if (!layer || layer.length === 0) return null;

  const { azimuth, range } = latLonToPolar(lat, lon, volume.lat, volume.lon);
  const radialIdx = findNearestRadialIndex(layer, azimuth, field);
  if (radialIdx < 0) return null;

  const gateSize = volume.gateSizes[li];
  const startRange = volume.startRanges[li];
  const elevation = layer[radialIdx].elevation || volume.elevations[li] || 0;
  const slant = groundToSlantRange(range, elevation);
  const gate = Math.floor((slant - startRange) / gateSize);
  if (gate < 0) return null;

  const n = layer.length;

  /**
   * 方位方向的邻居索引（含中心）。
   *
   * ★ 不能直接用数组下标 ±1 ★
   *   层里混着长圈/短圈以及“只有部分字段”的残缺径向（实测约 18% 的径向
   *   没有 dBZ 矩），下标 ±1 可能连续踩到空径向，导致 9 点里只剩 3 个有效，
   *   均值因此失效。这里按“有该字段数据的径向”向外扩展，取最近的
   *   `2*radius+1` 条，既保持方位邻近性，又不会漏采样。
   */
  const azIndices: number[] = [radialIdx];
  const wanted = 2 * radius + 1;
  for (let step = 1; step < n && azIndices.length < wanted; step++) {
    for (const idx of [(radialIdx - step + n) % n, (radialIdx + step) % n]) {
      if (azIndices.length >= wanted) break;
      if (layer[idx].fields[field].length > 0 && !azIndices.includes(idx)) {
        azIndices.push(idx);
      }
    }
  }

  let sum = 0;
  let validCount = 0;
  let totalCount = 0;
  let center: number | null = null;

  for (let ai = 0; ai < azIndices.length; ai++) {
    const ri = azIndices[ai];
    const arr = layer[ri].fields[field];
    for (let dg = -radius; dg <= radius; dg++) {
      const g = gate + dg;
      if (g < 0 || g >= arr.length) continue;
      totalCount++;
      const v = arr[g];
      if (!Number.isFinite(v) || v === UNDEF) continue;
      validCount++;
      sum += v;
      // 中心点：方位索引与距离库都取 0 偏移
      if (ai === 0 && dg === 0) center = v;
    }
  }

  return {
    center,
    mean: validCount >= MIN_NEIGHBORS_FOR_MEAN ? sum / validCount : null,
    validCount,
    totalCount
  };
}

/**
 * 在按方位角升序排列的径向数组里，找「方位最近且该字段有数据」的径向。
 *
 * ★ 为什么要按字段找 ★
 *   同一仰角的长圈（460km）与短圈（230km）是两批独立径向，方位步长略有差异
 *   （0.98° vs 0.99°），且长圈没有 V/W。若只按“最近方位”取一条，
 *   可能取到长圈而拿不到 V/W，或取到短圈而丢掉 460km 的反射率。
 *
 * 实现：二分定位方位夹缝（O(log n)），再从该处向两侧逐条比较，
 *       取“该字段有数据且方位差最小”的一条；最多检查 16 条
 *       （长短圈在同方位附近的条数远小于此）。
 */
function findNearestRadialIndex(
  layer: RstmRadial[],
  azimuth: number,
  field: RstmField
): number {
  const n = layer.length;
  if (n === 0) return -1;

  // 二分：第一个 azimuth >= 目标的位置
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (layer[mid].azimuth < azimuth) lo = mid + 1;
    else hi = mid;
  }

  let bestIdx = -1;
  let bestDiff = Infinity;
  const WINDOW = 8; // 向两侧各检查 8 条
  for (let d = 0; d < WINDOW; d++) {
    for (const idx of [(lo + d) % n, (lo - d - 1 + n) % n]) {
      const r = layer[idx];
      if (!r || r.fields[field].length === 0) continue;
      let diff = Math.abs(r.azimuth - azimuth);
      if (diff > 180) diff = 360 - diff; // 跨 0° 方向
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = idx;
      }
    }
    // 已经足够近（远小于数据自身的 0.98° 步长）就不必再往外找
    if (bestIdx >= 0 && bestDiff < 0.6) break;
  }
  return bestIdx;
}

/** findNearestRadialIndex 的对象版（取样用） */
function findNearestRadial(
  layer: RstmRadial[],
  azimuth: number,
  field: RstmField
): RstmRadial | null {
  const i = findNearestRadialIndex(layer, azimuth, field);
  return i < 0 ? null : layer[i];
}

/* ───────────────── 极坐标 → 笛卡尔网格（供现有渲染/取值链路复用） ───────────────── */

/**
 * 栅格化步长（度）：250m 库长在低纬约 0.00225°，取 0.01°（约 1km）。
 */
const GRID_DELTA = 0.01;

/** 栅格点数上限（防御性）：覆盖范围异常时避免分配超大数组 */
const MAX_GRID_POINTS = 2_000_000;

/**
 * 邻域回找的偏移序列（按优先级排序）：
 *   先跨方位（同距离库，±1/±2 个方位 ≈ ±1°/±2°），
 *   再沿径向向内外找（±1~±4 个库 ≈ ±250m~±1km）。
 * 数据本身约 0.98° 一个方位、250m 一个库，这个范围内的值属于“同一片回波”，
 * 位移量不超过数据自身分辨率，不会把远处的值搬到近处。
 */
const NEIGHBOR_AZ_OFFSETS = [1, -1, 2, -2];
const NEIGHBOR_GATE_OFFSETS = [1, -1, 2, -2, 3, -3, 4, -4];

/**
 * 取某个（方位索引, 距离库）的字段值；缺测时在邻域回找。
 *
 * ★ 为什么需要邻域回找 ★
 *   多普勒量（V/W）被雷达质量控制大量剔除：实测 0.5° 层 100~230km 区间
 *   V/W 覆盖率仅约 16%（信噪比低被剔除），严格“缺测即透明”会让色斑图
 *   呈现放射状空白。Python 端用极坐标 pcolormesh 按原始格连续绘制，
 *   观感上没有这种空洞。
 *   这里在 ±2 个方位 / ±4 个库的范围内取最近有值：
 *     - 有回波处不会因单个库被剔而出现针孔空白；
 *     - 整片无回波（邻域同样缺测）时仍然透明，不会无中生有。
 *
 * @param layer     该仰角层的径向数组（按方位升序，长短圈交错）
 * @param radialIdx 径向在数组中的下标（相邻下标 ≈ 相邻方位）
 * @param gate      距离库序号
 * @param field     字段名
 */
function pickWithNeighbors(
  layer: RstmRadial[],
  radialIdx: number,
  gate: number,
  field: RstmField
): number | null {
  const n = layer.length;

  const valueAt = (ri: number, g: number): number | null => {
    if (ri < 0 || ri >= n || g < 0) return null;
    const arr = layer[ri].fields[field];
    if (g >= arr.length) return null;
    const v = arr[g];
    return Number.isFinite(v) && v !== UNDEF ? v : null;
  };

  const direct = valueAt(radialIdx, gate);
  if (direct !== null) return direct;

  // ① 跨方位：同距离库在相邻方位找（回波在方位向通常连续）
  for (const off of NEIGHBOR_AZ_OFFSETS) {
    const v = valueAt((radialIdx + off + n) % n, gate);
    if (v !== null) return v;
  }

  // ② 沿径向：本方位相邻距离库（回波在径向通常连续）
  for (const dg of NEIGHBOR_GATE_OFFSETS) {
    const v = valueAt(radialIdx, gate + dg);
    if (v !== null) return v;
  }

  return null;
}

/**
 * 把某一仰角层的极坐标数据转换为等经纬度网格（RadarGrid），
 * 以便复用现有渲染 / 范围过滤 / 点击取值链路。
 *
 * 转换口径与 sampleRstmValue 完全一致（最近邻），
 * 因此“图上颜色”与“点击取值”不会互相矛盾。
 *
 * @param volume   解析得到的基数据体
 * @param layerIdx 仰角层序号（越界自动钳制）
 * @param field    取哪个字段（默认滤波后反射率 dBZ）
 * @returns RadarGrid；该层无有效数据时返回 null
 */
export function volumeToGrid(
  volume: RstmVolume,
  layerIdx = 0,
  field: RstmField = 'dBZ'
): RadarGrid | null {
  const li = Math.min(Math.max(layerIdx, 0), volume.layers.length - 1);
  const layer = volume.layers[li];
  if (!layer || layer.length === 0) return null;

  const gateSize = volume.gateSizes[li];
  const startRange = volume.startRanges[li];
  const maxRange = volume.maxRanges[li];

  // —— 1) 覆盖范围：该层全部有效格点的经纬度包围盒 ——
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  let hasData = false;

  for (const radial of layer) {
    const arr = radial.fields[field];
    for (let g = 0; g < arr.length; g++) {
      if (!Number.isFinite(arr[g]) || arr[g] === UNDEF) continue;
      // 库中心比库起点更接近实际探测位置。
      // 注意：这里的距离是**沿波束斜距**，换算经纬度前必须转成地面距离
      // （高仰角层差距大：19.5° 时 123km 斜距对应的地面距离只有约 115km）
      const slant = startRange + (g + 0.5) * gateSize;
      if (slant > maxRange) continue; // 超出该层设计距离的库是无效残留
      const ground = slantToGroundRange(slant, radial.elevation);
      const p = polarToLatLon(radial.azimuth, ground, volume.lat, volume.lon);
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
      hasData = true;
    }
  }
  if (!hasData) return null;

  // —— 2) 等经纬度网格（第 0 行在最北，yDelta 为负） ——
  let xSize = Math.ceil((maxLon - minLon) / GRID_DELTA) + 1;
  let ySize = Math.ceil((maxLat - minLat) / GRID_DELTA) + 1;
  if (xSize * ySize > MAX_GRID_POINTS) {
    const scale = Math.sqrt(MAX_GRID_POINTS / (xSize * ySize));
    xSize = Math.max(1, Math.floor(xSize * scale));
    ySize = Math.max(1, Math.floor(ySize * scale));
  }

  const data = new Float32Array(xSize * ySize).fill(UNDEF);

  for (let r = 0; r < ySize; r++) {
    const lat = maxLat - r * GRID_DELTA;
    for (let c = 0; c < xSize; c++) {
      const lon = minLon + c * GRID_DELTA;
      const { azimuth, range } = latLonToPolar(lat, lon, volume.lat, volume.lon);

      // 按字段找“方位最近且有数据”的径向（保留精确方位，不再按 1° 取整）
      const radialIdx = findNearestRadialIndex(layer, azimuth, field);
      if (radialIdx < 0) continue;
      const radial = layer[radialIdx];
      // 地面距离 → 沿波束斜距（按该径向实际仰角，高仰角层不可省略）
      const slant = groundToSlantRange(
        range,
        radial.elevation || volume.elevations[li] || 0
      );
      const gate = Math.floor((slant - startRange) / gateSize);
      if (gate < 0 || gate >= radial.fields[field].length) continue;
      if (slant > maxRange) continue;

      // 缺测时在邻域回找，避免单个库/单个方位被质量控制剔除后形成针孔空白
      const v = pickWithNeighbors(layer, radialIdx, gate, field);
      if (v !== null) data[r * xSize + c] = v;
    }
  }

  return {
    stationId: volume.stationId,
    stationName: volume.stationName,
    lat: volume.lat,
    lon: volume.lon,
    product: field,
    time: volume.time,
    units: '',
    undef: UNDEF,
    xStart: minLon,
    xDelta: GRID_DELTA,
    xSize,
    yStart: maxLat,
    yDelta: -GRID_DELTA,
    ySize,
    data,
    isSynthetic: false
  };
}

/* ───────────────────────── 小工具 ───────────────────────── */

function readU16(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readI16(buf: Uint8Array, offset: number): number {
  const v = readU16(buf, offset);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function readI32(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt32(offset, true);
}

function readF32(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat32(offset, true);
}
