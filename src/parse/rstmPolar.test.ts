/**
 * parse/rstmPolar.test.ts —— 极坐标 / 斜距换算回归测试
 *
 * 这些换算是“图上颜色 = 点击取值”的基础，拆分后必须保持原有精度。
 */
import { describe, expect, it } from 'vitest';
import {
  groundToSlantRange,
  latLonToPolar,
  polarToLatLon,
  slantToGroundRange
} from './rstmPolar';

describe('rstmPolar', () => {
  it('经纬度 ↔ 极坐标往返一致', () => {
    const radarLat = 37.37;
    const radarLon = 117.93;
    for (const [lat, lon] of [
      [37.5, 118.2],
      [36.8, 117.2],
      [38.2, 118.8]
    ]) {
      const polar = latLonToPolar(lat, lon, radarLat, radarLon);
      expect(polar.azimuth).toBeGreaterThanOrEqual(0);
      expect(polar.azimuth).toBeLessThan(360);
      expect(polar.range).toBeGreaterThan(0);

      const back = polarToLatLon(polar.azimuth, polar.range, radarLat, radarLon);
      expect(back.lat).toBeCloseTo(lat, 6);
      expect(back.lon).toBeCloseTo(lon, 6);
    }
  });

  it('地面距离 ↔ 沿波束斜距往返误差 < 0.5m', () => {
    const elevations = [0.5, 1.5, 6, 19.5];
    const groundRanges = [10_000, 100_000, 230_000, 460_000];

    for (const elevation of elevations) {
      for (const ground of groundRanges) {
        const slant = groundToSlantRange(ground, elevation);
        // 斜距恒 >= 地面距离；高仰角差距更大
        expect(slant).toBeGreaterThanOrEqual(ground - 1e-6);
        const back = slantToGroundRange(slant, elevation);
        expect(Math.abs(back - ground)).toBeLessThan(0.5);
      }
    }
  });

  it('仰角越高，同样地面距离对应的斜距越大', () => {
    const ground = 100_000;
    const low = groundToSlantRange(ground, 0.5);
    const high = groundToSlantRange(ground, 19.5);
    expect(high).toBeGreaterThan(low);
  });
});
