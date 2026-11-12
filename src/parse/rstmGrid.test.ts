/**
 * parse/rstmGrid.test.ts —— 极坐标栅格化与 per-volume LRU 回归测试
 *
 * 用一条方位 0° 的极小径向构造体数据，避免依赖真实雷达大文件。
 */
import { describe, expect, it } from 'vitest';
import {
  buildGridLayerPayload,
  GRID_CACHE_LIMIT,
  groundToSlantFast,
  layerToGrid,
  peekVolumeGrid
} from './rstmGrid';
import { groundToSlantRange } from './rstmPolar';
import { volumeToGrid } from './cinradVolume';
import type { RstmField } from './rstmRadials';
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

/* ─────────────── per-volume LRU（多屏不同仰角/字段不再互相挤掉） ─────────────── */

/** 多字段径向：7 个字段都有值（用于缓存共存/淘汰用例） */
function makeMultiRadial(azimuth: number, values: number[]): RstmRadial {
  const arr = Float32Array.from(values);
  const empty = new Float32Array(0);
  return {
    azimuth,
    elevation: 0.5,
    nyquist: 20,
    seconds: 0,
    microseconds: 0,
    fields: {
      dBT: arr,
      dBZ: arr,
      V: arr,
      W: arr,
      ZDR: arr,
      CC: arr,
      KDP: arr,
      SNRH: empty,
      PHIDP: empty
    }
  };
}

function makeMultiVolume(): RstmVolume {
  const v = makeVolume();
  v.layers = [[makeMultiRadial(0, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])]];
  return v;
}

describe('volumeToGrid per-volume LRU', () => {
  it('同层多字段共存缓存（单条缓存时代会被交替请求挤掉）', () => {
    const volume = makeMultiVolume();
    const dbz = volumeToGrid(volume, 0, 'dBZ');
    const vel = volumeToGrid(volume, 0, 'V');
    const width = volumeToGrid(volume, 0, 'W');
    expect(dbz).not.toBeNull();
    expect(vel).not.toBeNull();
    expect(width).not.toBeNull();
    // 三个字段都还在缓存里：再取 dBZ 仍是同一引用
    expect(volumeToGrid(volume, 0, 'dBZ')).toBe(dbz);
  });

  it('超过条数上限淘汰最旧条目', () => {
    const volume = makeMultiVolume();
    const fields: RstmField[] = ['dBT', 'dBZ', 'V', 'W', 'ZDR', 'CC', 'KDP'];
    expect(fields.length).toBeGreaterThan(GRID_CACHE_LIMIT);
    const first = volumeToGrid(volume, 0, fields[0]);
    for (const f of fields.slice(1)) volumeToGrid(volume, 0, f);
    // 最早的 dBT 已被淘汰：重算得到新对象
    const again = volumeToGrid(volume, 0, fields[0]);
    expect(again).not.toBe(first);
    expect(again!.data.length).toBe(first!.data.length);
  });

  it('peekVolumeGrid 只查缓存不计算', () => {
    const volume = makeMultiVolume();
    expect(peekVolumeGrid(volume, 0, 'dBZ')).toBeNull();
    const grid = volumeToGrid(volume, 0, 'dBZ');
    expect(peekVolumeGrid(volume, 0, 'dBZ')).toBe(grid);
  });
});

describe('layerToGrid 与单层载荷（Worker 传输契约）', () => {
  it('单层载荷栅格化结果与完整 volume 完全一致', () => {
    const volume = makeVolume();
    const full = volumeToGrid(volume, 0, 'dBZ');
    const payload = buildGridLayerPayload(volume, 0);
    expect(payload).not.toBeNull();
    const fromPayload = layerToGrid(payload!, 0, 'dBZ');
    expect(fromPayload).not.toBeNull();
    expect(fromPayload!.xSize).toBe(full!.xSize);
    expect(fromPayload!.ySize).toBe(full!.ySize);
    expect(fromPayload!.xStart).toBe(full!.xStart);
    expect(fromPayload!.yStart).toBe(full!.yStart);
    expect(Array.from(fromPayload!.data)).toEqual(Array.from(full!.data));
  });

  it('空层返回 null（不构造载荷）', () => {
    const volume = makeVolume();
    volume.layers = [[]];
    expect(buildGridLayerPayload(volume, 0)).toBeNull();
    expect(layerToGrid(volume, 0, 'dBZ')).toBeNull();
  });
});
