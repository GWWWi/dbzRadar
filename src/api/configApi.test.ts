/**
 * api/configApi.test.ts —— 时间轴生成与吸附回归测试
 *
 * 时间轴与文件解耦：这里只验证规则（起点/终点/间隔/上限保护/吸附），
 * 不涉及网络请求。
 */
import { describe, expect, it } from 'vitest';
import { buildTimelineTimes, snapNearestTime } from './configApi';
import type { AppConfig, TimelineConfig } from '../types';

/** 2024-06-21 00:00:00 北京时间 */
const ANCHOR_MS = Date.UTC(2024, 5, 20, 16, 0, 0);

function makeConfig(timeline: Partial<TimelineConfig> = {}): AppConfig {
  return {
    timeline: {
      mode: 'obs',
      intervalMinutes: 6,
      lookbackDays: 1,
      forecastHours: 24,
      ...timeline
    },
    fileUrlTemplate: '',
    fileListUrl: ''
  };
}

describe('buildTimelineTimes', () => {
  it('实况模式：当前时间为终点，往前推 lookbackDays', () => {
    const times = buildTimelineTimes(makeConfig({ lookbackDays: 1 }), ANCHOR_MS);
    expect(times).toHaveLength(241); // 24h / 6min + 1
    expect(times[0]).toBe('2024-06-20T00:00:00');
    expect(times[times.length - 1]).toBe('2024-06-21T00:00:00');
  });

  it('预报模式：当前时间为起点，往后加 forecastHours', () => {
    const times = buildTimelineTimes(
      makeConfig({ mode: 'fcst', intervalMinutes: 30, forecastHours: 1 }),
      ANCHOR_MS
    );
    expect(times).toEqual([
      '2024-06-21T00:00:00',
      '2024-06-21T00:30:00',
      '2024-06-21T01:00:00'
    ]);
  });

  it('时次超过上限时放大间隔，不截断最新时次', () => {
    // 1 分钟 × 10 天 = 14401 档，应放大到 5 分钟（2881 档）
    const times = buildTimelineTimes(
      makeConfig({ intervalMinutes: 1, lookbackDays: 10 }),
      ANCHOR_MS
    );
    expect(times.length).toBeLessThanOrEqual(3000);
    expect(times[times.length - 1]).toBe('2024-06-21T00:00:00');
  });

  it('锚点取整到分钟，秒位恒为 00', () => {
    const times = buildTimelineTimes(
      makeConfig({ intervalMinutes: 30, lookbackDays: 0 }),
      ANCHOR_MS + 43_000
    );
    for (const t of times) expect(t.endsWith(':00')).toBe(true);
  });
});

describe('snapNearestTime', () => {
  const TIMES = ['2024-06-21T00:00:00', '2024-06-21T00:06:00'];

  it('吸附到最近时次', () => {
    expect(snapNearestTime(TIMES, '2024-06-21T00:04:00')).toBe('2024-06-21T00:06:00');
    expect(snapNearestTime(TIMES, '2024-06-21T00:02:00')).toBe('2024-06-21T00:00:00');
  });

  it('超出两端时收敛到首/末时次', () => {
    expect(snapNearestTime(TIMES, '2024-06-20T23:00:00')).toBe(TIMES[0]);
    expect(snapNearestTime(TIMES, '2024-06-21T01:00:00')).toBe(TIMES[1]);
  });

  it('时间轴为空时原样返回', () => {
    expect(snapNearestTime([], '2024-06-21T00:00:00')).toBe('2024-06-21T00:00:00');
  });
});
