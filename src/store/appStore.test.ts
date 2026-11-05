/**
 * store/appStore.test.ts —— 屏状态 mutation 回归测试
 *
 * 重点：loading 是“忙”状态位，独立于展示文案 status；新增屏不继承忙标记。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  appState,
  setLayout,
  setScreenLoading,
  setScreenStatus
} from './appStore';

/** 恢复为 1 屏的干净状态（store 是模块级单例，用例之间必须复位） */
afterEach(() => {
  if (appState.screens.length > 1) appState.screens.splice(1);
  const s = appState.screens[0];
  s.productId = 'dBZ';
  s.time = '';
  s.status = '';
  s.statusKind = 'info';
  s.loading = false;
  s.smooth = false;
  s.valueRange = null;
  s.elevations = [];
  s.elevationIndex = 0;
  appState.layout = 1;
  appState.activeScreenId = 0;
});

describe('ScreenState.loading', () => {
  it('只更新目标屏的忙标记', () => {
    setLayout(2);
    expect(appState.screens.every((s) => !s.loading)).toBe(true);

    setScreenLoading(0, true);
    expect(appState.screens[0].loading).toBe(true);
    expect(appState.screens[1].loading).toBe(false);

    setScreenLoading(0, false);
    expect(appState.screens[0].loading).toBe(false);
  });

  it('新增屏不继承上一屏的忙标记', () => {
    setScreenLoading(0, true);
    setLayout(4);

    expect(appState.screens).toHaveLength(4);
    expect(appState.screens[0].loading).toBe(true);
    for (const s of appState.screens.slice(1)) expect(s.loading).toBe(false);
  });

  it('未知屏 id 被忽略', () => {
    setLayout(1);
    expect(() => setScreenLoading(999, true)).not.toThrow();
    expect(appState.screens).toHaveLength(1);
  });

  it('loading 与展示文案解耦：清忙标记不会清文案', () => {
    setScreenLoading(0, true);
    setScreenStatus(0, '加载中…');
    expect(appState.screens[0].loading).toBe(true);
    expect(appState.screens[0].status).toBe('加载中…');

    setScreenLoading(0, false);
    expect(appState.screens[0].loading).toBe(false);
    expect(appState.screens[0].status).toBe('加载中…');
  });
});

describe('ScreenState.statusKind', () => {
  it('文案与语气同时写入（失败必须是 error，不能沿用进行中的蓝）', () => {
    setScreenStatus(0, '加载中…', 'busy');
    expect(appState.screens[0].statusKind).toBe('busy');

    setScreenStatus(0, '加载失败', 'error');
    expect(appState.screens[0].status).toBe('加载失败');
    expect(appState.screens[0].statusKind).toBe('error');
  });

  it('清空文案时语气复位为 info', () => {
    setScreenStatus(0, '加载失败', 'error');
    setScreenStatus(0, '');
    expect(appState.screens[0].status).toBe('');
    expect(appState.screens[0].statusKind).toBe('info');
  });

  it('不传语气时默认 info', () => {
    setScreenStatus(0, '上传数据 · a.bin');
    expect(appState.screens[0].statusKind).toBe('info');
  });
});
