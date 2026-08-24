/*
 * mapManager.ts —— 地图创建与天地图底图管理
 *
 * 职责：
 *   1) createRadarMap ：用 QuickEarth 的 LMap（基于 Leaflet）创建地图实例；
 *   2) addTiandituBase：叠加【天地图】底图 —— 矢量底图(vec_w) + 中文注记(cva_w)，
 *      使用用户提供的 key。这里用原生 Leaflet 瓦片图层加载，
 *      是最直接可靠的方式（key 完全由本项目掌控）。
 *   3) 多屏地图联动：registerMapLink/unregisterMapLink/setMapLink ——
 *      开启时任一屏缩放/移动地图，其余屏同步相同视野（缩放+平移）。
 */

import { LMap } from '@quickearth/leaflet';
import * as L from 'leaflet';

/** 天地图 key（用户提供的开发者 key） */
export const TIANDITU_KEY = '06e4468af90602eeac0786f63b17cc69';

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
  // EPSG3857 Web 墨卡托；关闭淡入动画避免重绘闪烁
  const map = new LMap(el, {
    crs: L.CRS.EPSG3857,
    fadeAnimation: false,
    zoomControl: true
  });
  map.setView(DEFAULT_VIEW, DEFAULT_ZOOM);
  return map;
}

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
 */
export function addTiandituBase(map: LMap): void {
  const key = TIANDITU_KEY;
  const common = {
    subdomains: '01234567',
    maxZoom: 18
  };
  // 矢量底图
  L.tileLayer(
    `https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&X={x}&Y={y}&L={z}&tk=${key}`,
    { ...common, attribution: '© 天地图' }
  ).addTo(map as unknown as L.Map);
  // 中文注记层（保证地名始终压在雷达回波之上更易判读时，可调整 pane）
  L.tileLayer(
    `https://t{s}.tianditu.gov.cn/DataServer?T=cva_w&X={x}&Y={y}&L={z}&tk=${key}`,
    common
  ).addTo(map as unknown as L.Map);
}

/* ───────────────────────── 多屏地图联动（缩放/平移同步） ───────────────────────── */

/** 联动开关（模块级，跨屏共享）；Toolbar 通过 setMapLink 切换 */
let mapLinkEnabled = true;

/**
 * 程序化同步视野的抑制标记：
 * setView 会触发其他地图的 move 事件，不加标记会互相触发形成死循环。
 */
let syncing = false;

/** 已登记的地图与其 move 处理器（组件卸载时按 map 解除） */
const linkedMaps: { map: LMap; onMove: () => void }[] = [];

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
  const onMove = () => {
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
  map.on('move', onMove);
  linkedMaps.push({ map, onMove });

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
    linkedMaps[idx].map.off('move', linkedMaps[idx].onMove);
    linkedMaps.splice(idx, 1);
  }
}
