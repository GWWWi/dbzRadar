/*
 * mapManager.ts —— 地图创建与底图管理
 *
 * 职责：
 *   1) createRadarMap ：用 QuickEarth 的 LMap（基于 Leaflet）创建地图实例；
 *   2) applyBaseMap   ：按模式切换底图（全局状态在 store，行为在本文件）：
 *        · admin  天地图行政底图（vec_w 矢量底图 + cva_w 中文注记）
 *        · border 国界/省界矢量底图：陆地 #efefdb、海洋 #97b6e1、
 *                 国界/省界线 #606266（世界 1px、中国 1px、省界 0.8px）
 *      国界模式不加载瓦片，避免与矢量底色冲突。
 *   3) 多屏地图联动：registerMapLink/unregisterMapLink/setMapLink ——
 *      开启时任一屏缩放/移动地图，其余屏同步相同视野（缩放+平移）。
 */

import { LMap } from '@quickearth/leaflet';
import * as L from 'leaflet';
import type { BaseMapMode } from '../types';
import { fetchWithTimeout } from '../utils/http';
// 边界数据用 ?url 引入：不内联进主包，首次切换到国界底图时才按需加载
import worldBorderUrl from '../mapBorder/worldGJ.json?url';
import chinaBorderUrl from '../mapBorder/chinaGJ.json?url';
import provinceBorderUrl from '../mapBorder/chinaSJ.json?url';

/** 天地图 key（用户提供的开发者 key） */
export const TIANDITU_KEY = '06e4468af90602eeac0786f63b17cc69';

/** 国界底图配色（按需求固定，勿随意调整） */
const LAND_COLOR = '#efefdb';
const OCEAN_COLOR = '#97b6e1';
const BORDER_COLOR = '#606266';

/** 国界底图矢量专用 pane：必须低于雷达图层，避免盖住色斑图 */
const BASE_PANE = 'qe-base-border';

/**
 * 默认视图中心：正对 SWAN 拼图数据区中心（107°E / 29°N 附近，川渝一带），
 * 与 QuickEarth 官网雷达示例一致。
 */
const DEFAULT_VIEW: [number, number] = [29, 105.5];
const DEFAULT_ZOOM = 6;

/**
 * 创建一张雷达显示地图。
 * @param el 地图容器元素或其 id
 * @returns QEL.LMap 地图实例
 */
export function createRadarMap(el: string | HTMLElement): LMap {
  // EPSG3857 Web 墨卡托；关闭淡入动画避免重绘闪烁；
  // preferCanvas：省界约 7.5 万点，Canvas 渲染远快于 SVG
  const map = new LMap(el, {
    crs: L.CRS.EPSG3857,
    fadeAnimation: false,
    zoomControl: true,
    preferCanvas: true,
    // 关闭角落的版权条：QE 构造器默认已把它设为 false，这里显式声明防版本变化；
    // 平台自带色标图例（Legend.vue），不需要地图内的版权标识
    attributionControl: false
  });
  map.setView(DEFAULT_VIEW, DEFAULT_ZOOM);

  // 兜底清理：QE 的底图/图层在初始化后可能再挂上 attribution 条
  const container = map.getContainer();
  stripAttribution(container);
  // QE 的图层是异步加载的，稍后再清一次
  setTimeout(() => stripAttribution(container), 800);

  return map;
}

/**
 * 移除地图角落的版权标识（Leaflet 的 attribution 条）。
 *
 * ★ 为什么需要运行时清理 ★
 *   QE 的 LMap 构造器会把 `attributionControl` 置为 false，但它的底图/图层
 *   在异步初始化时仍可能通过 `map.attributionControl.addAttribution(...)` 挂上
 *   版权文本，表现为地图左下/右下角出现一条小字标识。
 *   平台自带色标图例，这里统一移除（CSS 里也有同样的兜底）。
 */
function stripAttribution(el: HTMLElement): void {
  el.querySelectorAll('.leaflet-control-attribution').forEach((node) => node.remove());
}

/* ───────────────────────── 底图：行政（天地图）/ 国界（矢量） ───────────────────────── */

/**
 * 为地图叠加天地图底图与注记。
 *
 * 天地图 DataServer 接口说明：
 *   https://t{s}.tianditu.gov.cn/DataServer?T=<图层代码>&X={x}&Y={y}&L={z}&tk=<key>
 *   - vec_w ：矢量底图（Web 墨卡托）
 *   - cva_w ：矢量中文注记（城市名/道路名），叠加在底图之上
 * 子域 t0 ~ t7 可轮询以提升并发加载速度。
 *
 * @param map QEL.LMap 地图实例
 * @returns 本次添加的图层（切换底图时按此数组整体移除）
 */
export function addTiandituBase(map: LMap): L.Layer[] {
  const key = TIANDITU_KEY;
  const common = {
    subdomains: '01234567',
    maxZoom: 18
  };
  // 矢量底图
  const vec = L.tileLayer(
    `https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&X={x}&Y={y}&L={z}&tk=${key}`,
    { ...common, attribution: '© 天地图' }
  ).addTo(map as unknown as L.Map);
  // 中文注记层（保证地名始终压在雷达回波之上更易判读时，可调整 pane）
  const cva = L.tileLayer(
    `https://t{s}.tianditu.gov.cn/DataServer?T=cva_w&X={x}&Y={y}&L={z}&tk=${key}`,
    common
  ).addTo(map as unknown as L.Map);

  return [vec, cva];
}

/** 每张地图当前挂载的底图图层（切换时整体移除；卸载时必须 delete，避免持有地图引用） */
const baseLayers = new Map<LMap, L.Layer[]>();

/** 每张地图的底图切换序号：异步加载边界数据回来时，过期的切换结果直接丢弃 */
const baseTokens = new Map<LMap, number>();

/** 三份边界 GeoJSON（合计约 4MB）：首次切换到国界时加载一次并缓存 */
interface BorderGeoData {
  world: unknown;
  china: unknown;
  province: unknown;
}
let borderDataPromise: Promise<BorderGeoData> | null = null;

/** 拉取单个 GeoJSON（省界约 3MB，超时放宽到 20s） */
async function fetchGeo(url: string): Promise<unknown> {
  const resp = await fetchWithTimeout(url, 20000);
  if (!resp.ok) throw new Error('边界数据加载失败：HTTP ' + resp.status);
  return resp.json();
}

/** 加载三份边界数据（并发 + 缓存；失败不缓存，允许下次重试） */
function loadBorderData(): Promise<BorderGeoData> {
  if (!borderDataPromise) {
    borderDataPromise = Promise.all([
      fetchGeo(worldBorderUrl),
      fetchGeo(chinaBorderUrl),
      fetchGeo(provinceBorderUrl)
    ])
      .then(([world, china, province]) => ({ world, china, province }))
      .catch((e) => {
        borderDataPromise = null;
        throw e;
      });
  }
  return borderDataPromise;
}

/** 创建国界底图专用 pane（zIndex 190：低于瓦片 200 与覆盖物 400） */
function ensureBasePane(map: LMap): void {
  if (map.getPane(BASE_PANE)) return;
  const pane = map.createPane(BASE_PANE);
  pane.style.zIndex = '190';
}

/** 把一段 GeoJSON 画到底图 pane 上 */
function addGeoLayer(map: LMap, data: unknown, style: L.PathOptions): L.Layer {
  return L.geoJSON(data as never, {
    pane: BASE_PANE,
    style: () => style
  }).addTo(map as unknown as L.Map);
}

/** 移除某张地图上的全部底图图层 */
function clearBaseLayers(map: LMap): void {
  const layers = baseLayers.get(map);
  if (!layers) return;
  for (const item of layers) {
    try {
      item.remove();
    } catch {
      // 地图正在销毁时 remove 可能抛错，忽略即可
    }
  }
  baseLayers.delete(map);
}

/**
 * 应用指定底图模式（每张地图独立调用）。
 *
 * 国界模式：
 *   - 地图容器背景直接设为海洋色（最省事且不会有接缝）；
 *   - 陆地由 worldGJ / chinaGJ 多边形填充，省界只描边不填充；
 *   - 数据首次加载约 4MB，加载期间先显示海洋色，回来后补陆地。
 *
 * @param map  QEL.LMap 地图实例
 * @param mode admin=天地图；border=国界/省界矢量
 */
export async function applyBaseMap(map: LMap, mode: BaseMapMode): Promise<void> {
  const token = (baseTokens.get(map) ?? 0) + 1;
  baseTokens.set(map, token);

  clearBaseLayers(map);

  // 海洋色：国界模式用容器背景承载；切回行政时清空内联样式
  map.getContainer().style.backgroundColor = mode === 'border' ? OCEAN_COLOR : '';

  if (mode === 'admin') {
    baseLayers.set(map, addTiandituBase(map));
    return;
  }

  try {
    const data = await loadBorderData();
    // 加载期间用户又切了模式、或地图已卸载 → 丢弃本次结果
    if (baseTokens.get(map) !== token) return;

    ensureBasePane(map);
    const layers: L.Layer[] = [
      // 世界陆地 + 世界国界（1px）
      addGeoLayer(map, data.world, {
        color: BORDER_COLOR,
        weight: 1,
        fillColor: LAND_COLOR,
        fillOpacity: 1
      }),
      // 中国国界（1px）：覆盖世界数据里的中国部分
      addGeoLayer(map, data.china, {
        color: BORDER_COLOR,
        weight: 1,
        fillColor: LAND_COLOR,
        fillOpacity: 1
      }),
      // 省界（0.8px）：只描边不填充，避免盖住陆地色
      addGeoLayer(map, data.province, {
        color: BORDER_COLOR,
        weight: 0.8,
        fill: false
      })
    ];
    baseLayers.set(map, layers);
  } catch (e) {
    // 保持海洋色（用户可见异常），不静默混用天地图掩盖问题
    console.error('[mapManager] 国界底图加载失败：', e);
  }
}

/**
 * 切换所有已创建地图的底图（Toolbar 调用）。
 * 新屏在 RadarScreen 挂载时按 store 的当前模式单独应用，不走这里。
 */
export function applyBaseMapToAll(mode: BaseMapMode): void {
  for (const item of linkedMaps) void applyBaseMap(item.map, mode);
}

/* ───────────────────────── 多屏地图联动（缩放/平移同步） ───────────────────────── */

/** 联动开关（模块级，跨屏共享）；Toolbar 通过 setMapLink 切换 */
let mapLinkEnabled = true;

/**
 * 程序化同步视野的抑制标记：
 * setView 会触发其他地图的 move 事件，不加标记会互相触发形成死循环。
 */
let syncing = false;

/** 已登记的地图、move 处理器与待执行帧回调的取消函数（组件卸载时按 map 解除） */
const linkedMaps: { map: LMap; onMove: () => void; cancel: () => void }[] = [];

/**
 * 设置地图联动开关（Toolbar 调用，与 appState.syncMap 保持一致）。
 * true：任一屏缩放/移动地图时，其余屏同步相同视野；false：各屏独立操作。
 */
export function setMapLink(enabled: boolean): void {
  mapLinkEnabled = enabled;
}

/**
 * 把地图纳入联动管理（RadarScreen onMounted 时调用）。
 * 若已有其他屏地图且联动开启，新地图立即对齐到当前联动视野
 * （多屏切换布局时保持各屏视野一致）。
 */
export function registerMapLink(map: LMap): void {
  /** 本图待执行的帧回调 id（0 表示当前帧没有待执行任务） */
  let rafId = 0;

  /** 真正的一次联动同步：只在帧回调里执行，保证每帧最多一次 setView */
  const syncNow = (): void => {
    rafId = 0;
    if (!mapLinkEnabled || syncing) return;
    syncing = true;
    try {
      const center = map.getCenter();
      const zoom = map.getZoom();
      for (const item of linkedMaps) {
        if (item.map === map) continue;
        item.map.setView(center, zoom, { animate: false });
      }
    } finally {
      syncing = false;
    }
  };

  /**
   * 拖拽 / 滚轮缩放会连续触发 move 事件（每帧可能多次）。
   * 用 requestAnimationFrame 合并为“每帧最多同步一次”，
   * 避免 4~6 屏各自 setView 造成的布局抖动与主线程开销。
   *
   * ★ syncing 判断必须放在这里 ★
   *   syncNow 里对其他地图 setView 会同步触发它们的 move。
   *   若不加此判断，这些“程序化移动”会各自排一个帧回调，
   *   下一帧又反向 setView 回来，形成永不停止的帧循环。
   */
  const onMove = (): void => {
    if (syncing) return;
    if (rafId) return;
    rafId = requestAnimationFrame(syncNow);
  };

  map.on('move', onMove);
  linkedMaps.push({
    map,
    onMove,
    // 卸载时取消尚未执行的帧回调，防止地图销毁后仍被操作
    cancel: () => {
      if (!rafId) return;
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  });

  const first = linkedMaps[0];
  if (mapLinkEnabled && first && first.map !== map) {
    syncing = true;
    map.setView(first.map.getCenter(), first.map.getZoom(), { animate: false });
    syncing = false;
  }
}

/**
 * 解除地图联动登记（RadarScreen 卸载销毁地图前调用）。
 */
export function unregisterMapLink(map: LMap): void {
  const idx = linkedMaps.findIndex((it) => it.map === map);
  if (idx >= 0) {
    const [item] = linkedMaps.splice(idx, 1);
    // 先解绑事件，再取消待执行的帧回调：两者都做才是完整清理
    item.map.off('move', item.onMove);
    item.cancel();
  }

  // 底图登记表持有 map 引用，卸载时必须清理，否则整张地图无法被 GC 回收
  clearBaseLayers(map);
  baseTokens.delete(map);
}
