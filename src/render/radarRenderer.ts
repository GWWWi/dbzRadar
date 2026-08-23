/**
 * render/radarRenderer.ts —— 雷达网格渲染（“渲染的方法”，本平台核心）
 *
 * 把解析层输出的 RadarGrid 渲染为 QuickEarth 像素图层（LPixelLayer）。
 * 核心方法 renderRadar(map, grid, product) 完成以下 6 步：
 *
 *   1) 过滤弱值          —— 低于产品显示阈值的格点归入缺测（双保险之一）
 *   2) new GridData(...)            —— 一维数值数组包装为 QE 格点数据
 *   3) ensureGridDataOptions(...)   —— 规整网格坐标（x/y 起点、步长、格数）
 *   4) new MemoryGridDataProvider   —— 用内存格点构造数据源
 *   5) 构造分级填色规则 + bitmap 色例 —— 按产品 colorStops（NMC 组合反射率配色）
 *   6) new LPixelLayer() + setDrawOptions + setDataSource → map.addLayer
 *
 * ★ 渲染模式说明（重要）★
 *   反射率色斑图使用 GridDataGLFillMode.bitmap【格点填色】模式：
 *     - 每个格点按其数值落入的分级直接取该档颜色平铺；
 *     - 不做双线性插值 / 样条插值（pixel1/pixel2/shaded 等模式才会平滑），
 *       即“不需要平滑”，保持雷达产品原始的分级色块观感。
 *
 * ★ “蓝色底色”问题与修复（重要经验）★
 *   SWAN 拼图中无回波区域被编码为原始码 0，解码后为 -33 dBZ 的【有效值】
 *   （并非缺测）。bitmap 模式会把低于首个色标阈值的值钳位到第一档颜色，
 *   于是整幅网格被刷成第一档的蓝色。双保险修复：
 *     ① 色标最前面放一个 value 很低、alpha=0 的透明兜底档；
 *     ② 渲染前把低于“首个可见阈值”的值统一置为缺测——QE 对缺测格点
 *        直接透明渲染，此路径最可靠。
 *   同时按 QE 规范传入 colorScale（BitmapColorScaleGL，由同一套分级规则
 *   生成、gradient=false 分级平色），它是 bitmap 模式的正规配置
 *   （优先级高于 fillColor），保证分档颜色与 fillColor 完全一致。
 */

import {
  GridData,
  GridDataType,
  ensureGridDataOptions,
  MemoryGridDataProvider,
  GridDataGLFillMode,
  BitmapColorScaleGL,
  IGridDataProvider
} from '@quickearth/core';
import { LPixelLayer } from '@quickearth/leaflet';
import type { LMap } from '@quickearth/leaflet';
import type { RadarGrid, RadarProduct } from '../types';

/**
 * 根据产品色标构造 QE 的 fillColor 分级填色规则。
 * 规则结构：{ fieldName: '0', stops: [{ value, stop: [r,g,b,a] }, ...] }
 */
function buildColorRule(product: RadarProduct): {
  fieldName: string;
  stops: { value: number; stop: number[] }[];
} {
  return {
    fieldName: '0',
    stops: product.colorStops.map((s) => ({ value: s.value, stop: s.stop.slice() }))
  };
}

/**
 * 取产品的“首个可见阈值”：
 * 即色标中第一个 alpha>0 的档位值（透明兜底档不计）。
 * 反射率类产品该值为 5 dBZ；低于它的格点一律视为无回波（缺测）。
 */
export function firstVisibleThreshold(product: RadarProduct): number {
  const first = product.colorStops.find((s) => s.stop[3] > 0);
  return first ? first.value : Number.NEGATIVE_INFINITY;
}

/**
 * 过滤弱值：把 data 中低于显示阈值的数值就地替换为缺测哨兵值。
 * 直接在原数组上修改（调用方传入的是待丢弃的一次性数组）。
 */
function maskBelowThreshold(data: number[], undef: number, threshold: number): void {
  if (!Number.isFinite(threshold)) return;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    // 缺测值本身不动；低于阈值的有效值 → 缺测
    if (v !== undef && v < threshold) data[i] = undef;
  }
}

/**
 * 构造完整的绘制选项：分级规则 + bitmap 色例 + 格点填色模式。
 *
 * colorScale 由与 fillColor 相同的分级规则生成（createFromStopRules），
 * gradient=false 表示分级平色（不平滑），是 bitmap 模式的正规配置。
 */
function buildDrawOptions(product: RadarProduct): Record<string, unknown> {
  const rule = buildColorRule(product);
  // 位图色例纹理宽度取档位数×16，保证每个色带有足够的采样精度
  const width = product.colorStops.length * 16;
  const colorScale = BitmapColorScaleGL.createFromStopRules(
    rule as never,
    width,
    false,                        // false = 分级平色（不渐变、不平滑）
    0,                            // 起始档序号
    product.colorStops.length - 1 // 结束档序号
  );
  return {
    fillColor: rule,
    colorScale,
    fillMode: GridDataGLFillMode.bitmap, // ★ 格点填色：逐格平铺分档颜色
    optimizedInterp: false               // 关闭插值优化，避免缺测边界出现过渡色
  };
}

/**
 * 核心：把一个雷达网格渲染为地图上的像素图层（不平滑的分档色斑图）。
 *
 * @param map     QEL.LMap 地图实例
 * @param grid    解析得到的笛卡尔网格（本函数会就地过滤其中的弱值）
 * @param product 当前产品（决定分级配色与显示阈值）
 * @returns LPixelLayer 图层实例（供后续更新/移除）
 */
export function renderRadar(map: LMap, grid: RadarGrid, product: RadarProduct): LPixelLayer {
  // —— 1) 弱值过滤：低于首档可见阈值的值 → 缺测（解决“蓝色底色”） ——
  const threshold = firstVisibleThreshold(product);
  maskBelowThreshold(grid.data, grid.undef, threshold);

  // —— 2) 构造格点数据 ——
  // 参数：(数据类型, 列数, 行数, 数据, 缺测值, algo=0(原始值), scale, offset, createEmpty)
  // 缺测值对应的格点在渲染时保持透明。
  const gd = new GridData(
    GridDataType.Float32,
    grid.xSize,
    grid.ySize,
    grid.data,
    grid.undef,
    0,
    1,
    1,
    false
  );

  // —— 3) 构造并规整网格坐标选项 ——
  // x = 经度方向（列），y = 纬度方向（行）；yDelta 可为负（第 0 行在最北），
  // QuickEarth 的 ensureGridDataOptions 会自动校验并补齐缺省项。
  const gridOptions = {
    xStart: grid.xStart,
    xDelta: grid.xDelta,
    xSize: grid.xSize,
    yStart: grid.yStart,
    yDelta: grid.yDelta,
    ySize: grid.ySize
  };
  ensureGridDataOptions(gridOptions);

  // —— 4) 内存数据源：[[gd]] 表示单时次、单字段的格点场 ——
  const provider: IGridDataProvider = new MemoryGridDataProvider([[gd]], { gridOptions });

  // —— 5)+6) 创建像素图层（含分级规则 + bitmap 色例）并加入地图 ——
  const layer = new LPixelLayer();
  layer.setDrawOptions(buildDrawOptions(product) as never);
  layer.setDataSource(provider);
  (map as unknown as { addLayer(l: unknown): void }).addLayer(layer);

  return layer;
}

/**
 * 局部更新绘制选项（多屏对比时切换产品用）。
 * 数据不变、仅产品（色标）变化时调用，避免重建整个图层。
 * 注意：不同产品的显示阈值可能不同，因此这里同时做一次弱值过滤。
 */
export function updateRadarProduct(
  layer: LPixelLayer,
  grid: RadarGrid,
  oldThreshold: number,
  product: RadarProduct
): void {
  const newThreshold = firstVisibleThreshold(product);
  // 新阈值高于旧阈值时，需要把新落入“弱值”区间的格点补标记为缺测
  if (newThreshold > oldThreshold) {
    maskBelowThreshold(grid.data, grid.undef, newThreshold);
  }
  layer.setDrawOptions(buildDrawOptions(product) as never);
}

/**
 * 从地图移除雷达图层（时间切换重建前 / 组件卸载时调用）。
 */
export function removeRadar(map: LMap | null, layer: LPixelLayer | null): void {
  if (map && layer && typeof (map as unknown as { removeLayer?: unknown }).removeLayer === 'function') {
    (map as unknown as { removeLayer(l: unknown): void }).removeLayer(layer);
  }
}
