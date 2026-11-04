/**
 * api/radarApi.test.ts —— 取数并发与缓存回归测试
 *
 * 重点覆盖 P0：
 *   - 多屏共享同一在途请求时，一个调用方取消不能连累其它屏；
 *   - 所有等待者都取消时才真正中止底层下载；
 *   - 同一文件+产品命中缓存后不再发起请求。
 *
 * 用最小的 MICAPS m4 文本代替真实雷达文件，避免测试依赖大数据文件。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearGridCache, fetchRadarGrid, gridCacheSize } from './radarApi';
import type { RadarFileMeta } from '../types';

/** 2×2 的合法 MICAPS diamond 4 文本（19 个头字段 + 4 个数据点） */
const M4_TEXT = [
  'diamond 4 test',
  // 年 月 日 时 时效 层次 经度格距 纬度格距 起止经度 起止纬度 纬向/经向格点数 等值线参数
  '2024 01 01 00 0 0 0.1 -0.1 100 101 30 29 2 2 5 15 65 1 45',
  '1 2 3 4',
  ''
].join('\n');

const META: RadarFileMeta = {
  file: 'Z_RADR_I_Z9536_20240101000000_O_DOR_SA_CAP_FMT.bin',
  binFile: 'test-radar.bin',
  time: '2024-01-01T00:00:00',
  stationId: 'Z9536',
  stationName: 'Z9536',
  hasData: true,
  format: 'rstm'
};

/** 构造一个可控延迟的 Response；signal 取消时同步 reject */
function mockFetch(delayMs: number, onAbort?: () => void) {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response(new TextEncoder().encode(M4_TEXT), { status: 200 })),
          delayMs
        );
        const signal = init?.signal;
        if (!signal) return;
        const abort = (): void => {
          clearTimeout(timer);
          onAbort?.();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearGridCache();
});

describe('fetchRadarGrid 并发模型', () => {
  it('一个调用方取消不会取消其它屏共享的请求', async () => {
    const fetchMock = mockFetch(30);
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const first = fetchRadarGrid(META, 'dBZ', controller.signal);
    const second = fetchRadarGrid(META, 'dBZ');

    controller.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const grid = await second;

    expect(grid.data.length).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('所有等待者都取消时才中止底层下载', async () => {
    let innerAborted = false;
    const fetchMock = mockFetch(30, () => {
      innerAborted = true;
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const request = fetchRadarGrid(META, 'dBZ', controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(innerAborted).toBe(true);
  });

  it('缓存命中后不再发起请求，并返回同一网格对象', async () => {
    const fetchMock = mockFetch(0);
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchRadarGrid(META, 'dBZ');
    const second = await fetchRadarGrid(META, 'dBZ');

    expect(second).toBe(first);
    expect(gridCacheSize()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
