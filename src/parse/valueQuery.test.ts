/**
 * parse/valueQuery.test.ts —— 单点取值（原始值 / 九点均值 / 可见性说明）回归测试
 *
 * 这段逻辑原先内嵌在 useRadarScreen 的闭包里（依赖 map/layerGrid/currentVolume），
 * 现抽成纯函数，这里覆盖四类关键口径：
 *   1) 图上可见 → 直接给出数值、无说明；
 *   2) 有值但低于阈值 / 超出色标范围 → 仍给数值 + 注明原因（不再报“无数据”）；
 *   3) 网格外 / 缺测 → 无数据；
 *   4) RSTM 九点均值：center 与 mean 不同，且 mean 恰为 0 时不能被误判成“无数据”。
 */
import { describe, expect, it } from 'vitest';
import { fieldForProduct, queryValue } from './valueQuery';
import { UNDEF } from '../constants';
import type { RadarGrid, RadarProduct, RstmRadial, RstmVolume } from '../types';

/* ─────────────── 测试夹具 ─────────────── */

const PRODUCT: RadarProduct = {
  id: 'dBZ',
  name: '反射率（dBZ）',
  unit: 'dBZ',
  type: 'obs',
  colorStops: [
    { value: -100, stop: [0, 0, 0, 0] },
    { value: 5, stop: [66, 118, 255, 255] },
    { value: 40, stop: [253, 170, 48, 255] }
  ]
};

const RADAR_LAT = 33.24;
const RADAR_LON = 118.83;

/**
 * 10×10、0.01° 网格，目标点 (33.24, 118.83) 落在格点 (row=1, col=1) 上。
 *
 * ★ 起算值刻意对齐格点 ★
 *   若把点放在两个格点正中（如 xStart=118.825），浮点误差会让
 *   round(0.5) 落到 0 或 1 不确定 —— 那是测试夹具问题，不是取值逻辑问题。
 */
function makeGrid(value: number): RadarGrid {
  const xSize = 10;
  const ySize = 10;
  const data = new Float32Array(xSize * ySize).fill(UNDEF);
  data[1 * xSize + 1] = value;
  return {
    stationId: 'Z9517',
    stationName: 'TEST',
    lat: RADAR_LAT,
    lon: RADAR_LON,
    product: 'dBZ',
    time: '2026-10-18T00:01:31',
    units: 'dBZ',
    undef: UNDEF,
    xStart: 118.82,
    xDelta: 0.01,
    xSize,
    yStart: 33.25,
    yDelta: -0.01,
    ySize,
    data,
    isSynthetic: false
  };
}

function makeRadial(azimuth: number, values: number[]): RstmRadial {
  const empty = new Float32Array(0);
  return {
    azimuth,
    elevation: 0.5,
    nyquist: 27.23,
    seconds: 1792281691,
    microseconds: 0,
    fields: {
      dBT: empty,
      dBZ: new Float32Array(values),
      V: empty,
      W: empty,
      ZDR: empty,
      CC: empty,
      KDP: empty,
      SNRH: empty,
      PHIDP: empty
    }
  };
}

/**
 * 三条径向（方位 0 / 2 / 358，按升序存放），目标点在雷达站正上方 → gate 0。
 * @param threeAzimuths [方位 0 的值, 方位 2 的值, 方位 358 的值]
 */
function makeVolume(threeAzimuths: number[][]): RstmVolume {
  return {
    stationId: 'Z9517',
    stationName: 'TEST',
    lat: RADAR_LAT,
    lon: RADAR_LON,
    time: '2026-10-18T00:01:31',
    gateSize: 250,
    gateCounts: [10],
    gateSizes: [250],
    startRanges: [0],
    maxRanges: [460_000],
    nyquists: [27.23],
    elevations: [0.5],
    layers: [
      [
        makeRadial(0, threeAzimuths[0]),
        makeRadial(2, threeAzimuths[1]),
        makeRadial(358, threeAzimuths[2])
      ]
    ]
  };
}

/** 目标点坐标（= 雷达站位置，range 0 → gate 0） */
const AT = { lat: RADAR_LAT, lon: RADAR_LON };

function query(overrides: Partial<Parameters<typeof queryValue>[0]> = {}) {
  return queryValue({
    lat: AT.lat,
    lon: AT.lon,
    product: PRODUCT,
    volume: null,
    elevationIndex: -1,
    grid: null,
    range: null,
    threshold: 5,
    ...overrides
  });
}

/* ─────────────── 字段映射 ─────────────── */

describe('fieldForProduct', () => {
  it('产品 id 即字段名', () => {
    expect(fieldForProduct('dBZ')).toBe('dBZ');
    expect(fieldForProduct('V')).toBe('V');
    expect(fieldForProduct('SNRH')).toBe('SNRH');
  });

  it('未知产品回退 dBZ', () => {
    expect(fieldForProduct('NOT_A_PRODUCT')).toBe('dBZ');
  });
});

/* ─────────────── 栅格路径 ─────────────── */

describe('queryValue（非 RSTM 网格）', () => {
  it('图上可见：给出数值且无说明', () => {
    const r = query({ grid: makeGrid(30) });
    expect(r.center).toBe(30);
    expect(r.visible).toBe(true);
    expect(r.shown).toBe(30);
    expect(r.note).toBe('');
    expect(r.mean).toBeNull();
  });

  it('低于显示阈值：仍给数值并注明原因', () => {
    const r = query({ grid: makeGrid(3), threshold: 5 });
    expect(r.center).toBe(3);
    expect(r.visible).toBe(false);
    expect(r.note).toContain('低于显示阈值 5 dBZ');
    // 图上透明但弹窗仍要展示原始值
    expect(r.shown).toBe(3);
  });

  it('超出色标范围：仍给数值并注明原因', () => {
    const r = query({ grid: makeGrid(30), range: { min: 40, max: 60 } });
    expect(r.center).toBe(30);
    expect(r.visible).toBe(false);
    expect(r.note).toContain('超出当前色标范围');
    expect(r.shown).toBe(30);
  });

  it('网格外返回无数据', () => {
    const r = query({ grid: makeGrid(30), lat: 40, lon: 110 });
    expect(r.center).toBeNull();
    expect(r.visible).toBe(false);
    expect(r.shown).toBeNull();
    expect(r.note).toContain('无数据');
  });

  it('格点缺测返回无数据', () => {
    const grid = makeGrid(30);
    grid.data[1 * grid.xSize + 1] = UNDEF;
    const r = query({ grid });
    expect(r.center).toBeNull();
    expect(r.shown).toBeNull();
    expect(r.note).toContain('无数据');
  });

  it('阈值边界：等于阈值时可见', () => {
    const r = query({ grid: makeGrid(5), threshold: 5 });
    expect(r.visible).toBe(true);
    expect(r.note).toBe('');
  });
});

/* ─────────────── RSTM 路径（九点均值） ─────────────── */

describe('queryValue（RSTM 九点均值）', () => {
  it('center 取中心库，mean 取 3×3 有效值平均', () => {
    // 三方位值：[10,20]、[20,30]、[30,40] → gate0/1 全部有效共 6 个
    // center = 10（方位 0 的 gate 0）
    // mean = (10+20 + 20+30 + 30+40) / 6 = 150/6 = 25
    const volume = makeVolume([
      [10, 20],
      [20, 30],
      [30, 40]
    ]);
    const r = query({
      volume,
      elevationIndex: 0,
      grid: makeGrid(25),
      threshold: 5
    });

    expect(r.center).toBe(10);
    expect(r.mean).toBe(25);
    expect(r.validCount).toBe(6);
    expect(r.totalCount).toBe(6);
    expect(r.visible).toBe(true);
  });

  it('九点均值恰为 0 时不能被误判成无数据', () => {
    // 所有值都是 0：mean = 0，若用 `!mean` 判断会被误判成“无数据”
    const volume = makeVolume([
      [0, 0],
      [0, 0],
      [0, 0]
    ]);
    const r = query({ volume, elevationIndex: 0, grid: makeGrid(0), threshold: 0 });

    expect(r.center).toBe(0);
    expect(r.mean).toBe(0);
    expect(r.note).toBe(''); // 不应是“无数据”
    expect(r.shown).toBe(0);
  });

  it('有效库不足（< 5）时不给均值', () => {
    // 只保留一条有数据的径向 → 邻域里只有 gate0/gate1 两个有效库
    const volume = makeVolume([
      [10, 20],
      [20, 30],
      [30, 40]
    ]);
    volume.layers[0][1].fields.dBZ = new Float32Array(0);
    volume.layers[0][2].fields.dBZ = new Float32Array(0);

    const r = query({ volume, elevationIndex: 0, grid: makeGrid(15), threshold: 5 });
    expect(r.center).toBe(10);
    expect(r.mean).toBeNull(); // 2 < 5
    expect(r.validCount).toBe(2);
  });

  it('RSTM 全部缺测时退回栅格值，不报无数据', () => {
    // 所有径向的 dBZ 都为空 → 极坐标取不到，退回栅格
    const volume = makeVolume([
      [2, 2],
      [2, 2],
      [2, 2]
    ]);
    for (const radial of volume.layers[0]) radial.fields.dBZ = new Float32Array(0);

    const r = query({ volume, elevationIndex: 0, grid: makeGrid(0), threshold: 0 });
    expect(r.center).toBe(0); // 栅格兜底
    expect(r.mean).toBeNull(); // 没有邻域数据
    expect(r.shown).toBe(0);
    expect(r.note).toBe('');
  });
});
