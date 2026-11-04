/**
 * parse/rstmGrid.ts —— RSTM 极坐标 → 等经纬度网格（供现有渲染/取值链路复用）
 *
 * 转换口径与 rstmPolar.sampleRstmValue 完全一致（最近邻），
 * 因此“图上颜色”与“点击取值”不会互相矛盾。
 *
 * ★ 单条缓存 ★
 *   多屏同步时 6 个屏通常请求同一 volume + 仰角 + 字段；栅格化一次约
 *   70 万点，重复计算代价高。这里用 WeakMap 只缓存“最近一次”结果
 *   （约 3MB/volume），既能让多屏复用，又不会把 9 层 × 8 字段全部驻留内存。
 *   返回的 RadarGrid 只读：渲染层在副本上过滤弱值，取值函数只读。
 */
import { UNDEF } from '../constants';
import type { RadarGrid, RstmRadial, RstmVolume } from '../types';
import type { RstmField } from './rstmRadials';
import {
  findNearestRadialIndex,
  latLonToPolar,
  polarToLatLon,
  slantToGroundRange
} from './rstmPolar';

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

/* ─────────────── 地面距离 → 斜距查找表（栅格化热点） ─────────────── */

/**
 * 查找表步长（米）与最大斜距（米）。
 * 460km 探测距离内 100m 步长足够；线性插值误差远小于一个距离库（250m）。
 */
const SLANT_LUT_STEP = 100;
const SLANT_LUT_MAX = 500_000;
/** 最多缓存的仰角数（按 0.01° 取整）；异常数据导致抖动时清空重来 */
const SLANT_LUT_LIMIT = 32;

interface SlantLut {
  /** ground[i] = 斜距 i×step 对应的地面距离（单调递增） */
  grounds: Float64Array;
  slants: Float64Array;
}

const slantLuts = new Map<number, SlantLut>();

/** 取某仰角的查找表（首次调用时构建，约 5001 次 slantToGroundRange） */
function getSlantLut(elevationDeg: number): SlantLut {
  const key = Math.round(elevationDeg * 100);
  const hit = slantLuts.get(key);
  if (hit) return hit;

  if (slantLuts.size >= SLANT_LUT_LIMIT) slantLuts.clear();
  const normalized = key / 100;
  const count = Math.ceil(SLANT_LUT_MAX / SLANT_LUT_STEP) + 1;
  const grounds = new Float64Array(count);
  const slants = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const slant = i * SLANT_LUT_STEP;
    slants[i] = slant;
    grounds[i] = slantToGroundRange(slant, normalized);
  }
  const lut = { grounds, slants };
  slantLuts.set(key, lut);
  return lut;
}

/**
 * 地面距离 → 沿波束斜距（查找表 + 线性插值）。
 *
 * 与 groundToSlantRange 的二分实现相比，单次换算从 24 次三角/开方
 * 降为一次二分查找 + 插值；栅格化 70 万点时收益明显。
 * 超出表范围时返回原地面距离（数据最大 460km，正常不会触发）。
 *
 * 导出仅供测试对比精度；业务代码请优先用 volumeToGrid / groundToSlantRange。
 */
export function groundToSlantFast(groundRange: number, elevationDeg: number): number {
  if (groundRange <= 0) return Math.max(groundRange, 0);
  const lut = getSlantLut(elevationDeg);
  const last = lut.grounds.length - 1;
  if (groundRange > lut.grounds[last]) return groundRange;

  // 二分：第一个 ground >= target 的位置
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lut.grounds[mid] < groundRange) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return lut.slants[0];
  const g0 = lut.grounds[lo - 1];
  const g1 = lut.grounds[lo];
  const s0 = lut.slants[lo - 1];
  const s1 = lut.slants[lo];
  if (g1 === g0) return s1;
  return s0 + ((groundRange - g0) / (g1 - g0)) * (s1 - s0);
}

/** volume → 最近一次栅格化结果（key = 层索引|字段） */
const lastGridCache = new WeakMap<RstmVolume, { key: string; grid: RadarGrid }>();

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

  // 多屏同层同字段：直接复用上一次结果（只缓存 1 条，避免 9×8 份网格驻留）
  const cacheKey = li + '|' + field;
  const cached = lastGridCache.get(volume);
  if (cached && cached.key === cacheKey) return cached.grid;

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
      const slant = groundToSlantFast(
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

  const grid: RadarGrid = {
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
  lastGridCache.set(volume, { key: cacheKey, grid });
  return grid;
}
