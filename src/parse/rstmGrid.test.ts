/**
 * parse/rstmGrid.test.ts —— 极坐标栅格化与单条缓存回归测试
 *
 * 用一条方位 0° 的极小径向构造体数据，避免依赖真实雷达大文件。
 */
import { describe, expect, it } from 'vitest';
import { groundToSlantFast } from './rstmGrid';
import { groundToSlantRange } from './rstmPolar';
import { volumeToGrid } from './cinradVolume';
import type { RstmRadial, RstmVolume } from '../types';

/** 9 个字段的空容器（只有 dBZ 有数据） */
function makeRadial(azimuth: number, values: number[]): RstmRadial {
  const empty = new Float32Array(0);
  return {
    azimuth,
    elevation: 0.5,
    nyquist: 20,
    seconds: 0,
    microseconds: 0,
    fields: {
      dBT: empty,
      dBZ: Float32Array.from(values),
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

function makeVolume(): RstmVolume {
  return {
    stationId: 'ZTEST',
    stationName: 'ZTEST',
    lat: 30,
    lon: 105,
    time: '2024-01-01T00:00:00',
    gateSize: 250,
    gateCounts: [10],
    gateSizes: [250],
    startRanges: [0],
    maxRanges: [3000],
    nyquists: [20],
    elevations: [0.5],
    layers: [[makeRadial(0, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])]]
  };
}

describe('groundToSlantFast', () => {
  it('与二分实现误差 < 1m（覆盖各仰角/距离）', () => {
    for (const elevation of [0.5, 1.5, 6, 19.5]) {
      for (const ground of [1_000, 50_000, 230_000, 460_000]) {
        const fast = groundToSlantFast(ground, elevation);
        const exact = groundToSlantRange(ground, elevation);
        expect(Math.abs(fast - exact)).toBeLessThan(1);
      }
    }
  });
});

describe('volumeToGrid', () => {
  it('生成合法网格并填充有效值', () => {
    const grid = volumeToGrid(makeVolume(), 0, 'dBZ');
    expect(grid).not.toBeNull();
    expect(grid!.xSize).toBeGreaterThan(0);
    expect(grid!.ySize).toBeGreaterThan(0);
    expect(grid!.xDelta).toBe(0.01);
    expect(grid!.yDelta).toBe(-0.01);
    expect(grid!.undef).toBe(999999);
    expect(Array.from(grid!.data).some((v) => v !== grid!.undef)).toBe(true);
  });

  it('同一 volume + 层 + 字段复用最近一次结果', () => {
    const volume = makeVolume();
    const first = volumeToGrid(volume, 0, 'dBZ');
    const second = volumeToGrid(volume, 0, 'dBZ');
    expect(second).toBe(first);
  });

  it('该字段无数据时返回 null，不污染已有缓存', () => {
    const volume = makeVolume();
    const first = volumeToGrid(volume, 0, 'dBZ');
    expect(volumeToGrid(volume, 0, 'V')).toBeNull();
    expect(volumeToGrid(volume, 0, 'dBZ')).toBe(first);
  });
});
