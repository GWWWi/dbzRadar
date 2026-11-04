/**
 * utils/gridSample.ts —— 等经纬度网格的单点取值（纯函数）
 *
 * ★ 为什么放在 utils 而不是 render 层 ★
 *   radarRenderer 会 import QuickEarth（浏览器 / WebGL 依赖），
 *   而“点击取值 / 坐标查询”的逻辑需要在 Node 下单测。
 *   把网格取值下沉到这里，渲染层与取值层共用同一份实现，避免两套口径漂移。
 *
 * 口径约定：
 *   - sampleGridRaw  ：只判网格边界与缺测 → 得到“原始值”；
 *   - sampleGridValue：额外要求通过显示阈值与色标范围 → 与“图上有颜色”一致。
 */
import { isValueVisible } from './range';
import type { RadarGrid, ValueRange } from '../types';

/**
 * 经纬度 → 最近格点索引。越界返回 null。
 *
 * 注意 yDelta 为负（第 0 行在最北），因此行号用 (lat - yStart) / yDelta。
 */
function gridIndex(
  grid: RadarGrid,
  lat: number,
  lon: number
): { row: number; col: number } | null {
  const col = Math.round((lon - grid.xStart) / grid.xDelta);
  const row = Math.round((lat - grid.yStart) / grid.yDelta);
  if (col < 0 || col >= grid.xSize || row < 0 || row >= grid.ySize) return null;
  return { row, col };
}

/**
 * 栅格最近邻取值（**原始值**）：只判网格边界与缺测，不判阈值/范围。
 *
 * 用途：用户查到一个“图上透明”的位置时，仍能给出真实数值。
 */
export function sampleGridRaw(grid: RadarGrid, lat: number, lon: number): number | null {
  const idx = gridIndex(grid, lat, lon);
  if (!idx) return null;
  const v = grid.data[idx.row * grid.xSize + idx.col];
  return v === grid.undef || !Number.isFinite(v) ? null : v;
}

/**
 * 栅格最近邻取值（**可见值**）：额外要求通过显示阈值与色标范围。
 *
 * 与渲染层共用 `isValueVisible`，保证「图上有颜色 = 取值有值」。
 *
 * @param grid       解析后的网格
 * @param lat        纬度
 * @param lon        经度
 * @param minVisible 首个可见阈值（firstVisibleThreshold）；undefined 表示不限制
 * @param range      本屏色标范围；null/undefined 表示全范围
 */
export function sampleGridValue(
  grid: RadarGrid,
  lat: number,
  lon: number,
  minVisible?: number,
  range?: ValueRange | null
): number | null {
  const v = sampleGridRaw(grid, lat, lon);
  if (v === null) return null;
  return isValueVisible(v, minVisible, range) ? v : null;
}
