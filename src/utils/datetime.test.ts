/**
 * utils/datetime.test.ts —— 时间换算回归测试
 *
 * 平台语义固定为北京时间（Asia/Shanghai），与运行机器的本地时区无关。
 * 这里用 UTC 时间戳构造用例，验证输出不会随机器时区漂移。
 */
import { describe, expect, it } from 'vitest';
import {
  compact12ToISO,
  digits14ToISO,
  formatShortTime,
  isoToCompact,
  isoToMs,
  msToISO,
  msToText
} from './datetime';

/** 2024-06-21 00:00:00 北京时间（= 2024-06-20 16:00:00 UTC） */
const BEIJING_MIDNIGHT = Date.UTC(2024, 5, 20, 16, 0, 0);

describe('datetime', () => {
  it('msToISO 固定按北京时间输出', () => {
    expect(msToISO(BEIJING_MIDNIGHT, true)).toBe('2024-06-21T00:00:00');
    expect(msToISO(BEIJING_MIDNIGHT, false)).toBe('2024-06-21T00:00:00');
  });

  it('msToISO 默认把秒位归零，withSeconds 保留秒', () => {
    const ms = BEIJING_MIDNIGHT + 43_000;
    expect(msToISO(ms, false)).toBe('2024-06-21T00:00:00');
    expect(msToISO(ms, true)).toBe('2024-06-21T00:00:43');
  });

  it('isoToMs 把无时区 ISO 串按北京时间解析', () => {
    expect(isoToMs('2024-06-21T00:00:43')).toBe(BEIJING_MIDNIGHT + 43_000);
  });

  it('isoToMs 对显式带时区的串走原生解析', () => {
    // 带 Z 的串语义是 UTC：2024-06-21 00:00:43 UTC，不再按北京时间二次换算
    expect(isoToMs('2024-06-21T00:00:43Z')).toBe(
      Date.UTC(2024, 5, 21, 0, 0, 43)
    );
  });

  it('msToText 输出可读文本', () => {
    expect(msToText(BEIJING_MIDNIGHT, true)).toBe('2024-06-21 00:00:00');
  });

  it('formatShortTime 输出列表/屏头短文本', () => {
    expect(formatShortTime('2024-06-21T00:00:43')).toBe('06-21 00:00');
    expect(formatShortTime('2024-06-21T00:00:43', true)).toBe('06-21 00:00:43');
    expect(formatShortTime('')).toBe('--');
  });

  it('紧凑串与 ISO 串互转', () => {
    expect(isoToCompact('2024-06-21T00:00:43', 12)).toBe('202406210000');
    expect(isoToCompact('2024-06-21T00:00:43')).toBe('20240621000043');
    expect(compact12ToISO('202406210000')).toBe('2024-06-21T00:00:00');
    expect(digits14ToISO('20240621000043')).toBe('2024-06-21T00:00:43');
  });

  it('非法输入不抛错：返回 NaN 或空串', () => {
    expect(Number.isNaN(isoToMs(''))).toBe(true);
    expect(compact12ToISO('123')).toBe('');
    expect(digits14ToISO('123')).toBe('');
  });
});
