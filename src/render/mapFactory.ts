/**
 * render/mapFactory.ts —— QuickEarth 地图实例创建
 *
 * 只负责“建一张地图 + 清掉版权条”，底图与多屏联动见 baseMap.ts / mapLink.ts。
 */
import { LMap } from '@quickearth/leaflet';
import * as L from 'leaflet';

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
