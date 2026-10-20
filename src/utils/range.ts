/**
 * utils/range.ts —— 色标数值范围的判断与键生成
 *
 * 渲染层（过滤数据）、图例（色块高亮）、屏组件（判重）三处都需要
 * “某个值是否在显示范围内”的同一套语义，集中在这里避免各写一份。
 *
 * 语义：[min, max) —— 下限含、上限不含。
 * 这样“选中 20~50 档”对应 max = 55（50 档的下一档值），
 * 与色标分档 [value_i, value_{i+1}) 完全一致。
 */
import type { ValueRange } from '../types';

/**
 * 判断数值是否落在显示范围内。
 * @param v     格点值（调用方需先排除缺测值）
 * @param range 显示范围；null/undefined 表示全范围
 */
export function isValueInRange(v: number, range?: ValueRange | null): boolean {
  if (!range) return true;
  if (v < range.min) return false;
  // max 为 Infinity 时 Number.isFinite 为 false → 不限制上限
  return !Number.isFinite(range.max) || v < range.max;
}

/**
 * 生成范围的稳定字符串键，用于 watch 依赖与图层判重。
 * null 与“全范围”都得到空串，便于统一比较。
 */
export function valueRangeKey(range?: ValueRange | null): string {
  return range ? `${range.min}|${range.max}` : '';
}

/**
 * 值是否“可见” —— 渲染与点击取值共用的唯一口径。
 *
 * 渲染层据此把不可见值置为缺测（画成透明），
 * 取值函数据此返回 null，保证“点击有值 = 图上有颜色”。
 *
 * @param v          格点值（调用方需先排除缺测值）
 * @param minVisible 首个可见阈值（firstVisibleThreshold）；非有限值表示不限制
 * @param range      用户选择的数值范围；null/undefined 表示全范围
 */
export function isValueVisible(
  v: number,
  minVisible?: number,
  range?: ValueRange | null
): boolean {
  // 阈值无效（无色标）时不限制下限
  if (minVisible !== undefined && Number.isFinite(minVisible) && v < minVisible) return false;
  return isValueInRange(v, range);
}

/**
 * 档位索引闭区间 → 数值范围（图例滑块松手时调用）。
 *
 * 上界取“结束档的下一档值”（左闭右开），保证结束档整档可见：
 *   选中 20~50 档 → max = 55，值域 [20,55) 全部显示，与色标分档一致。
 * 选满全部档位 → 返回 null（全范围），避免在 store 里存冗余状态。
 *
 * @param stopValues 升序的可见档位值（来自 product.colorStops，已过滤透明档）
 * @param from       起始档索引（含）
 * @param to         结束档索引（含）
 */
export function rangeFromStopIndex(
  stopValues: number[],
  from: number,
  to: number
): ValueRange | null {
  const n = stopValues.length;
  if (n === 0) return null;

  const f = Math.min(Math.max(from, 0), n - 1);
  const t = Math.min(Math.max(to, f), n - 1);
  if (f === 0 && t === n - 1) return null;

  const max = t + 1 < n ? stopValues[t + 1] : Number.POSITIVE_INFINITY;
  return { min: stopValues[f], max };
}

/**
 * 数值范围 → 档位索引闭区间（图例滑块回显）。
 *
 * 用于“范围值 → 滑块位置”的反向换算；产品切换后范围值可能不在新色标上，
 * 这里按“第一个 >= 下界的档”和“第一个 >= 上界的前一档”收敛，保证有合法位置。
 */
export function stopIndexFromRange(
  stopValues: number[],
  range?: ValueRange | null
): [number, number] {
  const n = stopValues.length;
  if (n === 0) return [0, 0];
  if (!range) return [0, n - 1];

  // 下限：第一个 >= min 的档；若范围下限高于所有档，收敛到最后一档
  let from = stopValues.findIndex((v) => v >= range.min);
  if (from < 0) from = n - 1;

  // 上限：第一个 >= max 的档是“第一档不显示”，其前一档为结束档
  let to = n - 1;
  if (Number.isFinite(range.max)) {
    const firstExcluded = stopValues.findIndex((v) => v >= range.max);
    to = firstExcluded < 0 ? n - 1 : firstExcluded - 1;
  }

  return [from, Math.max(from, to)];
}
