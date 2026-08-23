/**
 * store/appStore.ts —— 全局响应式状态（Vue reactive 单例，不引入 Pinia）
 *
 * 集中管理所有跨屏共享的状态：
 *   - layout          ：多屏布局（1 / 2 / 4 / 6 屏）
 *   - products        ：产品目录（来自 productApi）
 *   - files           ：雷达文件清单（来自 radarApi）
 *   - screens         ：各屏配置 —— ★ 不同屏可分配不同产品/时间，实现对比 ★
 *   - activeScreenId  ：当前激活屏（产品列表与时间轴的作用对象）
 *   - playing         ：动画播放状态
 *   - syncPlay        ：多屏同步开关（true 时时间轴控制所有屏）
 *
 * 并导出一组 mutation 函数供组件调用。
 */

import { reactive, computed } from 'vue';
import type { RadarFileMeta, RadarProduct } from '../types';

/** 布局类型：1 / 2 / 4 / 6 屏 */
export type LayoutType = 1 | 2 | 4 | 6;

/** 单屏状态 */
export interface ScreenState {
  /** 屏序号（0 起） */
  id: number;
  /** 本屏当前产品代码（不同屏可不同 → 产品对比） */
  productId: string;
  /** 本屏当前观测时刻 ISO 串（不同屏可不同 → 时间对比） */
  time: string;
  /** 加载状态文本（'加载中...' 等，空串表示空闲） */
  status: string;
}

/** 全局应用状态形状 */
export interface AppState {
  layout: LayoutType;
  products: RadarProduct[];
  files: RadarFileMeta[];
  screens: ScreenState[];
  activeScreenId: number;
  playing: boolean;
  syncPlay: boolean;
}

/** 创建 n 个屏的初始配置 */
function createScreens(n: number): ScreenState[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    productId: 'Z', // 默认产品 = 基本反射率
    time: '',
    status: ''
  }));
}

/** 全局响应式状态实例（单例） */
export const appState = reactive<AppState>({
  layout: 1,
  products: [],
  files: [],
  screens: createScreens(1),
  activeScreenId: 0,
  playing: false,
  syncPlay: true
});

/* ─────────────────────────── mutations ─────────────────────────── */

/**
 * 切换布局：增减 screens 数组长度，尽量保留已有屏的配置。
 */
export function setLayout(layout: LayoutType): void {
  appState.layout = layout;
  const cur = appState.screens;
  if (cur.length < layout) {
    const base = cur[cur.length - 1] || { productId: 'Z', time: '', status: '' };
    while (cur.length < layout) {
      // 新增屏沿用上一屏的产品/时间作为初始值
      cur.push({ id: cur.length, productId: base.productId, time: base.time, status: '' });
    }
  } else if (cur.length > layout) {
    cur.splice(layout); // 截断多余屏（地图实例在组件卸载时销毁）
    if (appState.activeScreenId >= layout) appState.activeScreenId = layout - 1;
  }
}

/** 把某屏设为激活屏（点击屏幕时调用） */
export function setActiveScreen(id: number): void {
  if (id >= 0 && id < appState.screens.length) appState.activeScreenId = id;
}

/** 为指定屏设置产品（左侧产品列表作用于激活屏） */
export function setScreenProduct(id: number, productId: string): void {
  const s = appState.screens[id];
  if (s) s.productId = productId;
}

/**
 * 为指定屏设置观测时刻。
 * 开启“多屏同步”（syncPlay）时广播给所有屏；否则仅本屏（时间对比模式）。
 */
export function setScreenTime(id: number, time: string): void {
  if (!time) return;
  if (appState.syncPlay) {
    for (const s of appState.screens) s.time = time;
  } else {
    const s = appState.screens[id];
    if (s) s.time = time;
  }
}

/** 载入文件清单，并给尚未有时次的屏填入首个时次 */
export function setFiles(files: RadarFileMeta[]): void {
  appState.files = files;
  if (files.length > 0 && !appState.screens[0].time) {
    for (const s of appState.screens) s.time = files[0].time;
  }
}

/** 写入产品目录 */
export function setProducts(products: RadarProduct[]): void {
  appState.products = products;
}

/** 设置播放状态 */
export function setPlaying(p: boolean): void {
  appState.playing = p;
}

/** 设置多屏同步开关 */
export function setSyncPlay(v: boolean): void {
  appState.syncPlay = v;
}

/** 更新某屏加载状态提示 */
export function setScreenStatus(id: number, status: string): void {
  const s = appState.screens[id];
  if (s) s.status = status;
}

/**
 * 按产品代码查找产品（找不到时回退到第一个产品，保证永不返回 undefined）。
 * 供渲染组件安全取用。
 */
export function getProductByIdSafe(id: string): RadarProduct {
  return (
    appState.products.find((p) => p.id === id) ??
    appState.products[0] ?? { id, name: id, unit: '', colorStops: [] }
  );
}

/* ─────────────────────────── computed ─────────────────────────── */

/** 当前激活屏的 ScreenState（组件里用 computed 引用以保持响应性） */
export const activeScreen = computed<ScreenState>(
  () => appState.screens[appState.activeScreenId]
);

/** 当前时间轴上的全部时刻（去重升序） */
export const timelineTimes = computed<string[]>(() => {
  const set = new Set<string>();
  for (const f of appState.files) if (f.time) set.add(f.time);
  return Array.from(set).sort();
});
