/**
 * utils/range.test.ts —— 色标范围口径回归测试
 *
 * 语义为左闭右开 [min, max)，与色标分档 [value_i, value_{i+1}) 一致。
 * 渲染过滤、点击取值、图例滑块三处共用本文件，口径变化必须先改测试。
 */
import { describe, expect, it } from 'vitest';
import {
  isValueInRange,
  isValueVisible,
  rangeFromStopIndex,
  stopIndexFromRange,
  valueRangeKey
} from './range';

/** 模拟可见色档（已过滤透明兜底档） */
const STOPS = [5, 10, 20, 30, 40, 50];

describe('range', () => {
  it('isValueInRange 左闭右开', () => {
    const range = { min: 20, max: 55 };
    expect(isValueInRange(20, range)).toBe(true);
    expect(isValueInRange(54.99, range)).toBe(true);
    expect(isValueInRange(55, range)).toBe(false);
    expect(isValueInRange(19.99, range)).toBe(false);
  });

  it('max 为 Infinity 表示不限制上限', () => {
    expect(isValueInRange(1e9, { min: 0, max: Infinity })).toBe(true);
  });

  it('isValueVisible 同时应用阈值与范围', () => {
    expect(isValueVisible(4.9, 5)).toBe(false);
    expect(isValueVisible(5, 5)).toBe(true);
    expect(isValueVisible(60, 5, { min: 20, max: 55 })).toBe(false);
    expect(isValueVisible(30, 5, { min: 20, max: 55 })).toBe(true);
  });

  it('rangeFromStopIndex 选满全部档时返回 null（全范围）', () => {
    expect(rangeFromStopIndex(STOPS, 0, STOPS.length - 1)).toBeNull();
  });

  it('rangeFromStopIndex 上界取结束档的下一档值', () => {
    // 选中 20~40 档 → [20, 50)
    expect(rangeFromStopIndex(STOPS, 2, 4)).toEqual({ min: 20, max: 50 });
    // 选中最后一档 → 上限为 Infinity
    expect(rangeFromStopIndex(STOPS, 5, 5)).toEqual({ min: 50, max: Infinity });
  });

  it('stopIndexFromRange 是 rangeFromStopIndex 的反向换算', () => {
    expect(stopIndexFromRange(STOPS, null)).toEqual([0, STOPS.length - 1]);
    expect(stopIndexFromRange(STOPS, { min: 20, max: 50 })).toEqual([2, 4]);
    expect(stopIndexFromRange(STOPS, { min: 50, max: Infinity })).toEqual([5, 5]);
  });

  it('valueRangeKey 把 null 与全范围统一为空串', () => {
    expect(valueRangeKey(null)).toBe('');
    expect(valueRangeKey({ min: 20, max: 50 })).toBe('20|50');
  });
});
