/**
 * store/appStore.test.ts —— 屏状态 mutation 回归测试
 *
 * 重点：loading 是“忙”状态位，独立于展示文案 status；新增屏不继承忙标记；
 * 布局收缩时激活屏按 id（而非数组下标）回退。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  appState,
  setActiveScreen,
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

describe('setLayout 收缩布局', () => {
  it('激活屏被截掉时回退到最后一个保留屏', () => {
    setLayout(4);
    setActiveScreen(3);
    setLayout(2);

    expect(appState.screens).toHaveLength(2);
    expect(appState.activeScreenId).toBe(appState.screens[appState.screens.length - 1].id);
  });

  it('激活屏仍在保留范围内时保持不变', () => {
    setLayout(4);
    setActiveScreen(1);
    setLayout(2);

    expect(appState.activeScreenId).toBe(1);
  });

  it('按 id 而不是数组下标判断：id 大于 layout 但仍被保留时不误改激活屏', () => {
    setLayout(2);
    // 模拟“删除单屏 / 恢复布局”等未来场景：id 不连续（[0, 5]）。
    appState.screens[1].id = 5;
    setActiveScreen(5);
    // 临时加第三屏再收缩回 2：保留集仍为 [0, 5]，激活屏 id=5 存活。
    // 旧写法 `activeScreenId >= layout`（5 >= 2）会把它误改成 layout-1=1，
    // 而 id=1 根本不存在 → 激活屏指向幽灵屏。
    appState.screens.push({ ...appState.screens[0], id: 6 });
    setLayout(2);

    expect(appState.screens).toHaveLength(2);
    expect(appState.activeScreenId).toBe(5);
  });
});
