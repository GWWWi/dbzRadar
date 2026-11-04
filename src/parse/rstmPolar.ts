/**
 * parse/rstmPolar.ts —— RSTM 极坐标换算与按库取样
 *
 * 职责：
 *   - 经纬度 ↔ 极坐标（方位角 + 地面距离）；
 *   - 地面距离 ↔ 沿波束斜距（4/3 地球半径模型）；
 *   - 最近邻单库取样（sampleRstmValue）与 3×3 邻域均值（sampleRstmNeighborhood）；
 *   - 按字段查找最近径向（栅格化也复用 findNearestRadialIndex）。
 */
import { UNDEF } from '../constants';
import type { RstmRadial, RstmSample, RstmVolume } from '../types';
import type { RstmField } from './rstmRadials';

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
 *
 * 栅格化（rstmGrid）也会复用本函数，避免再写一套最近径向逻辑。
 */
export function findNearestRadialIndex(
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
