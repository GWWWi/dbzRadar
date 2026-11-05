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
  DataSourceMode,
  RadarFileMeta,
  RadarProduct,
  ValueRange
} from '../types';
// 静态产品目录：产品目录尚未加载时提供可用色标的兜底（config 层不反向依赖 store）
import {
  getProductById as getStaticProductById,
  getProductList as getStaticProductList
} from '../config/products';
import type { ScreenStatusKind } from '../constants/messages';

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
  /** 展示用状态文本（'加载中…'/'该时次无数据' 等，空串表示空闲），文案见 constants/messages */
  status: string;
  /**
   * 状态语气（配色与读屏播报强弱）：busy=进行中 / warn=需注意 / error=失败。
   * ★ 必须与 status 一起由 setScreenStatus 写入 ★ 只改文案不改语气会让
   *   失败提示沿用“进行中”的颜色，等于把错误藏起来。
   */
  statusKind: ScreenStatusKind;
  /**
   * 本屏画面是否为“示意数据”（文件未能真实解码，画面由合成兜底生成）。
   * ★ 必须独立于 status ★ 数据来源标签（如「上传数据 · a.bin」）与这条警示
   *   需要同时显示，塞进同一个字符串会丢掉其中一个；屏头渲染为红色标记，
   *   业务上禁止用于任何判断（见 docs/USER_GUIDE.md）。
   */
  synthetic: boolean;
  /**
   * 是否正在取数/解析（播放避让用）。
   * ★ 不要用 status 字符串判断加载态：文案会变，且“识别中…”等状态也属于忙。
   */
  loading: boolean;
  /** 本屏色斑图平滑开关（每屏独立）：true=双线性插值，false=格点填色（原始色块） */
  smooth: boolean;
  /**
   * 本屏色标数值范围（每屏独立）：null=全范围。
   * 范围外的格点在渲染时置为缺测（不显示颜色），见 utils/range.ts。
   */
  valueRange: ValueRange | null;
  /**
   * 本屏可用仰角列表（度）：仅当当前数据是 RSTM 基数据体（9 仰角层）时非空。
   * 空数组 = 当前数据没有仰角维度（拼图 / m4 / 合成 RSTM），UI 隐藏仰角选择器。
   */
  elevations: number[];
  /** 本屏当前仰角索引（elevations 的下标）；非 RSTM 数据时固定为 0 */
  elevationIndex: number;
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
  /**
   * 地图底图模式（全局）：
   *   - border：国界/省界矢量底图（默认，启动即为国界）
   *   - admin ：天地图行政底图
   */
  baseMap: BaseMapMode;
  /**
   * 数据来源模式（来自 config.json 的 dataSourceMode，缺省 both）。
   * 只影响取数编排：latest 不加载文件清单；upload 完全不取服务器数据。
   * 上传入口在三种模式下均保留，不据此隐藏 UI。
   */
  dataSourceMode: DataSourceMode;
  /**
   * 本地文件夹文件的时次（ISO 串，升序）。
   * 由「文件夹文件」选择目录后写入：时间轴显示绿色刻度并可跳转 / 取数到这些时次。
   * 与 files（服务器清单）分离，避免 refresh 误把本地文件当成 URL 去 fetch。
   */
  localFileTimes: string[];
}

/** 创建 n 个屏的初始配置 */
function createScreens(n: number): ScreenState[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    // 默认产品 = 反射率；必须与 config/products.ts 的 id 一致（旧代码用 'Z'，
    // 产品列表改成 dBZ/dBT/... 之后会对不上，导致屏头与概览显示原始 id）
    productId: 'dBZ',
    time: '',
    status: '',
    statusKind: 'info',
    synthetic: false,
    loading: false,
    smooth: false,
    valueRange: null, // 默认全范围（不裁剪色标）
    elevations: [], // 非 RSTM 基数据体时为空（UI 隐藏仰角选择器）
    elevationIndex: 0
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
  // 默认国界底图：不依赖天地图 key，弱网/离线也能看出地理轮廓
  baseMap: 'border',
  // 默认两者同时存在，保持原有完整行为（配置加载后按 config.json 覆盖）
  dataSourceMode: 'both',
  // 本地文件夹文件时次（选择目录后写入）
  localFileTimes: []
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
      productId: 'dBZ',
      time: '',
      status: '',
      statusKind: 'info',
      synthetic: false,
      loading: false,
      smooth: false,
      valueRange: null,
      elevations: [],
      elevationIndex: 0
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
        statusKind: 'info',
        synthetic: false,
        loading: false,
        smooth: base.smooth,
        valueRange: base.valueRange ? { ...base.valueRange } : null,
        elevations: [],
        elevationIndex: 0
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
    console.warn(`[appStore] 忽略未知产品：${productId}`);
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
 * 记录本屏当前数据的可用仰角列表（RSTM 基数据体的 9 个仰角）。
 *
 * 空数组表示当前数据没有仰角维度（拼图 / m4 / 合成 RSTM），
 * 此时仰角选择器隐藏、elevationIndex 重置为 0。
 * 非空时把 elevationIndex 钳制到合法范围（保留用户上一次的选择）。
 */
export function setScreenElevations(id: number, elevations: number[]): void {
  const s = findScreen(id);
  if (!s) return;
  s.elevations = elevations;
  s.elevationIndex = elevations.length
    ? Math.min(Math.max(s.elevationIndex, 0), elevations.length - 1)
    : 0;
}

/**
 * 切换本屏仰角层（RSTM 基数据体有效；其它数据类型调用无效果）。
 * @param index elevations 数组的下标
 */
export function setScreenElevation(id: number, index: number): void {
  const s = findScreen(id);
  if (!s || s.elevations.length === 0) return;
  s.elevationIndex = Math.min(Math.max(index, 0), s.elevations.length - 1);
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

/**
 * 设置数据来源模式（App 启动读取 config.json 后调用）。
 * 只影响初始化与取数编排，不改变上传入口的显隐。
 */
export function setDataSourceMode(mode: DataSourceMode): void {
  appState.dataSourceMode = mode;
}

/**
 * 登记本地文件夹文件的时次（选择目录后调用；空数组表示清空）。
 * 时间轴据此显示刻度并可跳转，取数时优先命中本地 File。
 */
export function setLocalFileTimes(times: string[]): void {
  appState.localFileTimes = [...times].sort();
}

/**
 * 更新某屏展示状态文本与语气（不参与播放避让判断）。
 *
 * @param status 状态文案（空串 = 空闲）
 * @param kind   语气：busy=进行中 / warn=需注意 / error=失败；默认 info。
 *               文案为空时语气一并复位，避免清屏后残留红色语义。
 */
export function setScreenStatus(
  id: number,
  status: string,
  kind: ScreenStatusKind = 'info'
): void {
  const s = findScreen(id);
  if (!s) return;
  s.status = status;
  s.statusKind = status ? kind : 'info';
}

/**
 * 标记本屏画面是否为示意数据（合成兜底）。
 * ★ 与 setScreenStatus 分开 ★ 该警示必须能与数据来源标签（上传文件名）同时显示。
 */
export function setScreenSynthetic(id: number, synthetic: boolean): void {
  const s = findScreen(id);
  if (s) s.synthetic = synthetic;
}

/**
 * 设置某屏“正在取数/解析”标记。
 * 播放避让应读本字段，而不是比较 status 文案。
 */
export function setScreenLoading(id: number, loading: boolean): void {
  const s = findScreen(id);
  if (s) s.loading = loading;
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
  console.warn(`[appStore] 未知产品 ${id}，回退到默认产品`);
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
  productId: 'dBZ',
  time: '',
  status: '',
  statusKind: 'info',
  synthetic: false,
  loading: false,
  smooth: false,
  valueRange: null,
  elevations: [],
  elevationIndex: 0
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
  // 基础时次：配置生成的时间轴优先，否则回退清单文件时刻
  const set = new Set<string>(appState.timeline);
  if (appState.timeline.length === 0) {
    for (const f of appState.files) if (f.time) set.add(f.time);
  }
  // 合并本地文件夹文件时次：它们不在配置栅格上，但时间轴需能选中 / 步进到
  for (const t of appState.localFileTimes) if (t) set.add(t);
  return Array.from(set).sort();
});
