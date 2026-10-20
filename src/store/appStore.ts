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
import type {
  AppConfig,
  BaseMapMode,
  RadarFileMeta,
  RadarProduct,
  ValueRange
} from '../types';
// 静态产品目录：产品目录尚未加载时提供可用色标的兜底（config 层不反向依赖 store）
import {
  getProductById as getStaticProductById,
  getProductList as getStaticProductList
} from '../config/products';

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
  /** 本屏色斑图平滑开关（每屏独立）：true=双线性插值，false=格点填色（原始色块） */
  smooth: boolean;
  /**
   * 本屏色标数值范围（每屏独立）：null=全范围。
   * 范围外的格点在渲染时置为缺测（不显示颜色），见 utils/range.ts。
   */
  valueRange: ValueRange | null;
}

/** 全局应用状态形状 */
export interface AppState {
  layout: LayoutType;
  products: RadarProduct[];
  files: RadarFileMeta[];
  /** 配置生成的时间轴（配置模式）；空数组表示未启用，回退用 files 推导 */
  timeline: string[];
  /** 数据文件地址模板（配置模式）；空串表示清单模式（按 files 匹配） */
  fileUrlTemplate: string;
  /** 当前应用配置（配置模式）；null 表示清单回退模式（时间轴上无时间选择控件） */
  timelineConfig: AppConfig | null;
  screens: ScreenState[];
  activeScreenId: number;
  playing: boolean;
  syncPlay: boolean;
  /** 多屏地图联动开关：true=任一屏缩放/移动地图时，其余屏同步相同视野 */
  syncMap: boolean;
  /** 地图底图模式（全局）：admin=天地图行政底图；border=国界/省界矢量底图 */
  baseMap: BaseMapMode;
}

/** 创建 n 个屏的初始配置 */
function createScreens(n: number): ScreenState[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    productId: 'Z', // 默认产品 = 基本反射率
    time: '',
    status: '',
    smooth: false,
    valueRange: null // 默认全范围（不裁剪色标）
  }));
}

/** 全局响应式状态实例（单例） */
export const appState = reactive<AppState>({
  layout: 1,
  products: [],
  files: [],
  timeline: [],
  fileUrlTemplate: '',
  timelineConfig: null,
  screens: createScreens(1),
  activeScreenId: 0,
  playing: false,
  syncPlay: true,
  syncMap: true,
  baseMap: 'admin'
});

/* ─────────────────────────── mutations ─────────────────────────── */

/**
 * 按屏 id 查找 ScreenState。
 *
 * ★ 禁止用 `screens[id]` 直接索引 ★
 *   当前布局下 id 恰好等于数组下标，但那是巧合而不是契约。
 *   一旦后续加入“删除单屏 / 调整顺序 / 恢复布局”，下标与 id 就会错位，
 *   所有 mutation 都会改错屏。统一走本函数后，id 才是稳定标识，
 *   setLayout 只需保证 id 唯一。
 */
function findScreen(id: number): ScreenState | undefined {
  return appState.screens.find((s) => s.id === id);
}

/**
 * 切换布局：增减 screens 数组长度，尽量保留已有屏的配置。
 */
export function setLayout(layout: LayoutType): void {
  appState.layout = layout;
  const cur = appState.screens;
  if (cur.length < layout) {
    const base = cur[cur.length - 1] || {
      productId: 'Z',
      time: '',
      status: '',
      smooth: false,
      valueRange: null
    };
    // 新屏 id 取“当前最大 id + 1”：id 只要求唯一，不要求等于数组下标
    let nextId = cur.reduce((max, s) => Math.max(max, s.id), -1) + 1;
    while (cur.length < layout) {
      // 新增屏沿用上一屏的产品/时间/平滑/范围作为初始值
      // （范围对象复制一份，避免多屏共享同一引用）
      cur.push({
        id: nextId++,
        productId: base.productId,
        time: base.time,
        status: '',
        smooth: base.smooth,
        valueRange: base.valueRange ? { ...base.valueRange } : null
      });
    }
  } else if (cur.length > layout) {
    cur.splice(layout); // 截断多余屏（地图实例在组件卸载时销毁）
    if (appState.activeScreenId >= layout) appState.activeScreenId = layout - 1;
  }
}

/** 把某屏设为激活屏（点击屏幕时调用）；id 不存在时忽略 */
export function setActiveScreen(id: number): void {
  if (findScreen(id)) appState.activeScreenId = id;
}

/** 产品是否真实存在于服务端目录或静态目录中 */
function productExists(id: string): boolean {
  return (
    appState.products.some((p) => p.id === id) || Boolean(getStaticProductById(id))
  );
}

/**
 * 为指定屏设置产品（左侧产品列表作用于激活屏）。
 *
 * 两道保护：
 *   1. 未知产品直接拒绝——原实现不校验，服务端下架某产品后屏的 productId
 *      仍指向旧值，屏头/图例显示的是兜底产品的名字，而 sc.productId 还是旧的，
 *      两个不同旧 id 之间切换时还会被判定为「产品没变」而不重绘。
 *   2. 切产品时清空 valueRange——范围是相对当前产品色标的绝对数值，
 *      从 Z（-10~70）切到 V（-30~30）后旧范围会把几乎全部格点判为缺测，
 *      整屏空白且图例滑块被静默 clamp。
 */
export function setScreenProduct(id: number, productId: string): void {
  const s = findScreen(id);
  if (!s || s.productId === productId) return;
  if (!productExists(productId)) {
    console.warn(`[store] 忽略未知产品：${productId}`);
    return;
  }
  s.productId = productId;
  s.valueRange = null;
}

/**
 * 为指定屏设置平滑显示开关（每屏独立，便于多屏对比平滑/不平滑效果）。
 * true=双线性插值渲染（平滑），false=格点填色（不平滑，保持分档色块）。
 */
export function setScreenSmooth(id: number, smooth: boolean): void {
  const s = findScreen(id);
  if (s) s.smooth = smooth;
}

/**
 * 设置本屏色标显示范围（null=恢复全范围）。
 * 范围外的格点在渲染时置为缺测（透明），取值时返回 null。
 */
export function setScreenRange(id: number, range: ValueRange | null): void {
  const s = findScreen(id);
  if (s) s.valueRange = range;
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
    const s = findScreen(id);
    if (s) s.time = time;
  }
}

/**
 * 保存应用配置（配置模式标记，供时间轴的时间选择控件重新生成时读取）。
 * null 表示清单回退模式。
 */
export function setTimelineConfig(config: AppConfig | null): void {
  appState.timelineConfig = config;
}

/**
 * 写入配置模式的时间轴与文件模板（configApi 生成后调用）。
 * 时间轴与实际文件无关，提前确定；给尚未有时次的屏填入最新时次
 * （实况模式为当前时间，预报模式为起报时间）。
 * @param times 升序时刻串数组
 * @param fileUrlTemplate 文件地址模板；空串表示清单模式
 */
export function setTimeline(times: string[], fileUrlTemplate: string): void {
  appState.timeline = times;
  appState.fileUrlTemplate = fileUrlTemplate;
  if (times.length > 0 && !appState.screens[0].time) {
    const latest = times[times.length - 1];
    for (const s of appState.screens) s.time = latest;
  }
}

/** 载入文件清单（清单模式），并给尚未有时次的屏填入首个时次 */
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

/** 设置多屏地图联动开关（缩放/平移视野同步，行为见 mapManager.setMapLink） */
export function setSyncMap(v: boolean): void {
  appState.syncMap = v;
}

/**
 * 设置地图底图模式（全局）。
 * 状态只负责 UI 高亮；真正的图层切换由 mapManager.applyBaseMapToAll 完成
 * （沿用“状态在 store、行为在 mapManager”的约定，render 层不反向依赖 store）。
 */
export function setBaseMap(mode: BaseMapMode): void {
  appState.baseMap = mode;
}

/** 更新某屏加载状态提示 */
export function setScreenStatus(id: number, status: string): void {
  const s = findScreen(id);
  if (s) s.status = status;
}

/**
 * 按产品代码取产品元信息（UI / 渲染侧唯一入口，永不返回 undefined）。
 *
 * 查找顺序：
 *   1) 已加载的产品目录（appState.products，即 fetchProductList 的返回值）；
 *   2) 启动早期目录尚未写入时，回退内置静态目录（src/config/products.ts）。
 *
 * ★ 必须回退到真实产品，不能返回 colorStops 为空的占位对象 ★
 *   渲染层用 `colorStops.length - 1` 作为色例终止档号，空数组会得到 -1，
 *   QE 的 BitmapColorScaleGL 收到非法档号可能直接抛错。
 *
 * 与 productApi.findProduct 的分工（store 不 import api 层，避免反向依赖）：
 *   - productApi.findProduct：数据访问层入口，服务器目录缓存优先，允许 undefined；
 *   - 本函数：UI 入口，保证返回可用色标；两者的最终兜底都是静态目录。
 */
export function getProductByIdSafe(id: string): RadarProduct {
  const loaded = appState.products.find((p) => p.id === id);
  if (loaded) return loaded;

  const staticHit = getStaticProductById(id);
  if (staticHit) return staticHit;

  // 未命中：显式告警后再兜底到目录第一项。
  // 原实现静默 `?? appState.products[0]`，调用方无法区分「命中」与「回退」，
  // 于是屏头、图例、色标用的是兜底产品，而 sc.productId 仍是旧 id，
  // 三者口径不一致且难以排查。
  console.warn(`[store] 未知产品 ${id}，回退到默认产品`);
  const fallback = appState.products[0] ?? getStaticProductList()[0];
  if (fallback) return fallback;

  // 理论上不可达（静态目录固定非空），仅为类型收窄保留
  return { id, name: id, unit: '', type: 'obs', colorStops: [] };
}

/* ─────────────────────────── computed ─────────────────────────── */

/**
 * 空屏兜底：setLayout 保证至少 1 屏，这里仅用于满足类型收窄，
 * 正常流程不会返回该对象。
 */
const EMPTY_SCREEN: ScreenState = {
  id: 0,
  productId: 'Z',
  time: '',
  status: '',
  smooth: false,
  valueRange: null
};

/** 当前激活屏的 ScreenState（按 id 查找，不依赖数组下标） */
export const activeScreen = computed<ScreenState>(
  () => findScreen(appState.activeScreenId) ?? appState.screens[0] ?? EMPTY_SCREEN
);

/**
 * 当前时间轴上的全部时刻（升序）：
 * 优先用配置生成的时间轴（setTimeline 写入）；未配置时回退为清单内文件时刻。
 */
export const timelineTimes = computed<string[]>(() => {
  if (appState.timeline.length > 0) return appState.timeline;
  const set = new Set<string>();
  for (const f of appState.files) if (f.time) set.add(f.time);
  return Array.from(set).sort();
});
