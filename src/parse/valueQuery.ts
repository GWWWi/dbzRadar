/**
 * parse/valueQuery.ts —— 单点取值（原始值 + 九点均值 + 可见性说明）
 *
 * ★ 为什么单独成模块 ★
 *   这段逻辑原先内嵌在 composables/useRadarScreen 里，与闭包中的
 *   map / layerGrid / currentVolume 绑定，既无法单测，也让该文件膨胀。
 *   抽成纯函数后：输入数据 + 坐标 → 输出结果，UI 层只负责弹窗与提示。
 *
 * 取值口径（与图上颜色保持一致）：
 *   - 原始值 center ：RSTM 走极坐标最近邻（无网格量化）；否则退回栅格最近邻；
 *   - 九点均值 mean  ：仅 RSTM 有，center + 周围 8 个库的有效值平均；
 *   - 图上可见性    ：用栅格口径（阈值 + 色标范围）判断，与渲染同源。
 *
 * 图上透明时仍然返回数值与原因（如“低于显示阈值 5 dBZ”），
 * 避免用户查到弱回波却得到“无数据”。
 */
import { sampleGridRaw, sampleGridValue } from '../utils/gridSample';
import { MOMENT_FIELD } from './rstmRadials';
import type { RstmField } from './rstmRadials';
import { sampleRstmNeighborhood, sampleRstmValue } from './rstmPolar';
import type {
  RadarGrid,
  RadarProduct,
  RadarQueryResult,
  RstmVolume,
  ValueRange
} from '../types';

/**
 * 产品代码 → RSTM 字段名。
 *
 * 产品 id 与字段名一致（见 config/products.ts：dBZ/dBT/V/W/ZDR/CC/KDP/SNRH），
 * 因为标准格式一个仰角层含 9 个矩，而渲染链路一次只画一个数值场。
 * 未登记的 id 回退滤波后反射率 dBZ。
 */
export function fieldForProduct(productId: string): RstmField {
  return productId in MOMENT_FIELD ? (productId as RstmField) : 'dBZ';
}

/**
 * 某字段的**原始值**（不判显示阈值、不判色标范围）。
 *
 * 优先走极坐标原始径向（`sampleRstmValue`，无网格量化，精度最高）；
 * 非 RSTM 数据或该层取不到时退回栅格原始值。
 *
 * 类型说明：`RstmSample` 的字段名与 `RstmField` 一一对应（dBT/dBZ/V/W/ZDR/
 * CC/KDP/SNRH/PHIDP），因此可以直接 `sample[field]` 索引，无需类型断言。
 */
export function rawValueAt(
  volume: RstmVolume | null,
  grid: RadarGrid | null,
  elevationIndex: number,
  lat: number,
  lon: number,
  field: RstmField
): number | null {
  if (volume && elevationIndex >= 0) {
    const sample = sampleRstmValue(volume, lat, lon, elevationIndex);
    if (sample) {
      const v = sample[field];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return grid ? sampleGridRaw(grid, lat, lon) : null;
}

/** queryValue 的输入 */
export interface QueryValueParams {
  lat: number;
  lon: number;
  /** 当前产品（决定字段、单位与阈值说明） */
  product: RadarProduct;
  /** 当前 RSTM 体数据（非 RSTM 数据为 null） */
  volume: RstmVolume | null;
  /** 当前仰角索引（volume 有效时 >= 0） */
  elevationIndex: number;
  /** 当前栅格（用于可见性判定与兜底取值） */
  grid: RadarGrid | null;
  /** 本屏色标范围（null = 全范围） */
  range: ValueRange | null;
  /** 首个可见阈值（firstVisibleThreshold(product) 的结果） */
  threshold: number;
}

/** queryValue 的输出：面板结果 + 弹窗所需的附加信息 */
export interface QueryValueResult extends RadarQueryResult {
  /** 图上是否可见（栅格口径：过阈值且过色标范围） */
  visible: boolean;
  /** 弹窗首选展示值：可见值优先，其次原始值；都没有则 null */
  shown: number | null;
}

/**
 * 在指定经纬度取值。
 *
 * @returns 面板展示所需的结果（含 center / mean / 有效数 / 说明 / 是否可见）
 */
export function queryValue(params: QueryValueParams): QueryValueResult {
  const { lat, lon, product, volume, elevationIndex, grid, range, threshold } = params;
  const field = fieldForProduct(product.id);

  // —— 九点邻域（仅 RSTM）；非 RSTM 时 center 退回原始值 ——
  const neighborhood =
    volume && elevationIndex >= 0
      ? sampleRstmNeighborhood(volume, lat, lon, elevationIndex, field)
      : null;

  const center = neighborhood
    ? neighborhood.center
    : rawValueAt(volume, grid, elevationIndex, lat, lon, field);

  // 图上可见性：与渲染同口径（阈值 + 色标范围）
  const visibleValue = grid ? sampleGridValue(grid, lat, lon, threshold, range) : null;

  const unit = product.unit ? ' ' + product.unit : '';
  let note = '';
  if (center === null && neighborhood?.mean == null) {
    note = '无数据（超出数据范围或缺测）';
  } else if (visibleValue === null && center !== null) {
    note =
      Number.isFinite(threshold) && center < threshold
        ? `低于显示阈值 ${threshold}${unit}（图上透明）`
        : '超出当前色标范围（图上透明）';
  }

  return {
    lat,
    lon,
    center,
    mean: neighborhood ? neighborhood.mean : null,
    validCount: neighborhood ? neighborhood.validCount : 0,
    totalCount: neighborhood ? neighborhood.totalCount : 0,
    unit: product.unit,
    note,
    visible: visibleValue !== null,
    shown: visibleValue ?? center
  };
}
