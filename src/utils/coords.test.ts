/**
 * utils/coords.test.ts —— 经纬度展示格式回归测试
 *
 * 重点：负值必须换成 S / W，不能出现 “-33.638°N”“-100.000°E” 这种方向错标。
 */
import { describe, expect, it } from 'vitest';
import { formatLat, formatLatLon, formatLon } from './coords';

describe('formatLat / formatLon', () => {
  it('北纬东经：保留小数位，不带正号', () => {
    expect(formatLat(33.6378)).toBe('33.638°N');
    expect(formatLon(118.9269)).toBe('118.927°E');
  });

  it('南纬西经：绝对值 + S / W，不出现负号与错误方向', () => {
    expect(formatLat(-33.6378)).toBe('33.638°S');
    expect(formatLon(-100.5, 1)).toBe('100.5°W');
  });

  it('赤道 / 本初子午线按 N / E 显示', () => {
    expect(formatLat(0)).toBe('0.000°N');
    expect(formatLon(0)).toBe('0.000°E');
  });

  it('非有限值给占位符，不输出 NaN°', () => {
    expect(formatLat(Number.NaN)).toBe('--');
    expect(formatLon(Number.POSITIVE_INFINITY)).toBe('--');
  });
});

describe('formatLatLon', () => {
  it('按调用方指定的小数位拼接', () => {
    expect(formatLatLon(33.6378, 118.9269)).toBe('33.638°N, 118.927°E');
    expect(formatLatLon(33.6378, 118.9269, 4)).toBe('33.6378°N, 118.9269°E');
  });
});
