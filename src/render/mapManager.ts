/**
 * render/mapManager.ts —— 地图能力对外门面
 *
 * 实现已拆分：
 *   - mapFactory：createRadarMap（地图实例 + 版权条清理）；
 *   - baseMap   ：天地图/国界底图、边界数据缓存、底图切换 token；
 *   - mapLink   ：多屏缩放/平移联动（move 经 rAF 合并）。
 *
 * 本文件保留原有导出，调用方 import 路径不变：
 *   - applyBaseMapToAll 遍历已登记地图批量切换底图；
 *   - unregisterMapLink 同时解除联动登记并清理底图资源（保持旧语义）。
 */

import type { LMap } from '@quickearth/leaflet';
import type { BaseMapMode } from '../types';
import { applyBaseMap as applyBaseMapImpl, cleanupBaseMap } from './baseMap';
import { forEachLinkedMap, unregisterMapLink as unregisterLink } from './mapLink';

export { TILE_SERVICE_BASE, TIANDITU_KEY, addTiandituBase, applyBaseMap } from './baseMap';
export { createRadarMap } from './mapFactory';
export { registerMapLink, setMapLink } from './mapLink';

/**
 * 切换所有已创建地图的底图（Toolbar 调用）。
 * 新屏在 RadarScreen 挂载时按 store 的当前模式单独应用，不走这里。
 */
export function applyBaseMapToAll(mode: BaseMapMode): void {
  forEachLinkedMap((map) => void applyBaseMapImpl(map, mode));
}

/**
 * 解除地图联动登记并清理底图资源（RadarScreen 卸载销毁地图前调用）。
 *
 * ★ 两件事必须一起做 ★
 *   - 联动登记表持有 map 引用；
 *   - baseMap 的图层表/token 表也持有 map 引用；
 *   少清任何一处都会让整张地图无法被 GC 回收。
 */
export function unregisterMapLink(map: LMap): void {
  unregisterLink(map);
  cleanupBaseMap(map);
}
