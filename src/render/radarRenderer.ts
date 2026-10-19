/**
 * render/radarRenderer.ts —— 雷达网格渲染（“渲染的方法”，本平台核心）
 *
 * 把解析层输出的 RadarGrid 渲染为 QuickEarth 像素图层（LPixelLayer）。
 * 核心方法 renderRadar(map, grid, product) 完成以下 5 步：
 *
 *   1) 构造渲染副本        —— 在【新数组】上把低于产品显示阈值的格点置为缺测
 *   2) new GridData(...)            —— 副本包装为 QE 格点数据
 *   3) ensureGridDataOptions(...)   —— 规整网格坐标（x/y 起点、步长、格数）
 *   4) new MemoryGridDataProvider   —— 用内存格点构造数据源
 *   5) 构造分级填色规则 + bitmap 色例 + new LPixelLayer → map.addLayer
 *
 * ★ 渲染层不得修改 RadarGrid.data（P0 修复记录）★
 *   旧实现在原数组上过滤弱值。产品由低阈值切到高阈值时会补抹弱值，
 *   再切回低阈值产品时这些值已被永久写成缺测，无法恢复 —— 数据静默损坏。
 *   现在数据源持有过滤后的副本，原始网格始终完整，可随时按新阈值重新过滤。
 *
 * ★ 渲染模式说明（重要）★
 *   支持两种填色模式（每屏独立开关 screens[i].smooth，屏头可切换）：
 *     - 不平滑 GridDataGLFillMode.bitmap【格点填色】：
 *       每个格点按其数值落入的分级直接取该档颜色平铺，不做任何插值，
 *       保持雷达产品原始的分级色块观感（默认）。
 *     - 平滑 GridDataGLFillMode.pixel1【双线性插值】：
 *       先对格点值做双线性插值，再经同一套分级色例取色，
 *       色块边界过渡平滑（经典平滑色斑图观感）。
 *   两种模式共用同一套色标与缺测处理；运行中切换走 updateRadarSmooth
 *   局部刷新（setDrawOptions），不重建图层。
 *
 * ★ “蓝色底色”问题与修复（重要经验）★
 *   SWAN 拼图中无回波区域被编码为原始码 0，解码后为 -33 dBZ 的【有效值】
 *   （并非缺测）。bitmap 模式会把低于首个色标阈值的值钳位到第一档颜色，
 *   于是整幅网格被刷成第一档的蓝色。双保险修复：
 *     ① 色标最前面放一个 value 很低、alpha=0 的透明兜底档；
 *     ② 渲染前在数据副本上把低于“首个可见阈值”的值统一置为缺测——QE
 *        对缺测格点直接透明渲染，此路径最可靠（原始网格保持完整）。
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
import type { RadarGrid, RadarProduct, ValueRange } from '../types';
import { isValueVisible, valueRangeKey } from '../utils/range';

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
 * 构造“渲染用”数值副本：把低于显示阈值的有效值替换为缺测哨兵。
 *
 * ★ 为什么必须复制、不能就地修改 ★
 *   旧实现在 grid.data 上就地过滤。产品从低阈值切到高阈值时会补抹弱值，
 *   但再切回低阈值产品（如 反射率 5 dBZ → 径向速度 -30 m/s）时，这些值
 *   已经被永久写成缺测，无法恢复 —— 数据被静默破坏且不可逆。
 *   返回副本后，原始网格始终保留完整数值，每次渲染都能按当前阈值重新过滤。
 *
 * @param data      原始数值数组（不会被修改）
 * @param undef     缺测哨兵
 * @param threshold 首个可见阈值；非有限值表示不做阈值过滤
 * @param range     用户选择的数值范围（[min,max)）；null/undefined 表示全范围
 * @returns 过滤后的新数组（Float32Array，与 GridData 的 Float32 类型一致）
 */
function buildDisplayValues(
  data: Float32Array,
  undef: number,
  threshold: number,
  range?: ValueRange | null
): Float32Array {
  // 既无阈值也无范围 → 无需逐点判断，直接浅拷贝
  if (!Number.isFinite(threshold) && !range) return data.slice();

  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    // 缺测值本身不动；低于阈值或落在用户范围外的有效值 → 缺测（渲染透明）
    const masked = v !== undef && !isValueVisible(v, threshold, range);
    out[i] = masked ? undef : v;
  }
  return out;
}

/**
 * 按指定显示阈值构造 QE 内存数据源。
 *
 * 数据源内部持有的是“已过滤副本”，所以阈值一旦变化就必须重建 provider
 * （setDataSource）；只调 setDrawOptions 不会让已过滤的数据恢复。
 *
 * @param grid      原始网格（只读，函数内不修改）
 * @param threshold 首个可见阈值
 * @param range     用户选择的数值范围；null/undefined 表示全范围
 */
function createProvider(
  grid: RadarGrid,
  threshold: number,
  range?: ValueRange | null
): IGridDataProvider {
  const values = buildDisplayValues(grid.data, grid.undef, threshold, range);

  // 参数：(数据类型, 列数, 行数, 数据, 缺测值, algo=0(原始值), scale, offset, createEmpty)
  // 缺测值对应的格点在渲染时保持透明。
  const gd = new GridData(
    GridDataType.Float32,
    grid.xSize,
    grid.ySize,
    values,
    grid.undef,
    0,
    1,
    1,
    false
  );

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

  // [[gd]] 表示单时次、单字段的格点场
  return new MemoryGridDataProvider([[gd]], { gridOptions });
}

/**
 * 构造完整的绘制选项：分级规则 + bitmap 色例 + 填色模式。
 *
 * colorScale 由与 fillColor 相同的分级规则生成（createFromStopRules），
 * gradient=false 表示分级平色（不平滑），是 bitmap/pixel1 模式的正规配置。
 *
 * @param product 产品（决定分级配色）
 * @param smooth  true=双线性插值（平滑），false=格点填色（不平滑）
 */
function buildDrawOptions(product: RadarProduct, smooth: boolean): Record<string, unknown> {
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
    fillMode: smooth ? GridDataGLFillMode.pixel1 : GridDataGLFillMode.bitmap,
    optimizedInterp: false               // 关闭插值优化，避免缺测边界出现过渡色
  };
}

/**
 * 核心：把一个雷达网格渲染为地图上的像素图层。
 *
 * @param map     QEL.LMap 地图实例
 * @param grid    解析得到的笛卡尔网格（只读；弱值过滤在副本上完成）
 * @param product 当前产品（决定分级配色与显示阈值）
 * @param smooth  true=双线性插值（平滑），false=格点填色（不平滑，默认）
 * @param range   用户选择的色标数值范围；范围外置缺测（不显示颜色）
 * @returns LPixelLayer 图层实例（供后续更新/移除）
 */
export function renderRadar(
  map: LMap,
  grid: RadarGrid,
  product: RadarProduct,
  smooth = false,
  range?: ValueRange | null
): LPixelLayer {
  // —— 1) 构造数据源：在副本上过滤弱值与范围外数值（解决“蓝色底色”并支持范围裁剪）——
  // 注意：grid.data 保持原始值，供切换产品/调整范围时按新口径重新过滤、供点击取值使用。
  const threshold = firstVisibleThreshold(product);
  const provider = createProvider(grid, threshold, range);

  // —— 2) 创建像素图层（含分级规则 + 色例）并加入地图 ——
  const layer = new LPixelLayer();
  layer.setDrawOptions(buildDrawOptions(product, smooth) as never);
  layer.setDataSource(provider);
  (map as unknown as { addLayer(l: unknown): void }).addLayer(layer);

  return layer;
}

/**
 * 强制 QE 图层立即重绘。
 *
 * ★ 为什么需要 ★
 *   QE 的 GL 图层没有持续渲染循环：setDataSource / setDrawOptions 只替换
 *   数据与样式，绘制依赖内部帧调度。实测表现为“数据已换、画面还是旧的，
 *   必须缩放或拖动地图才刷新”（范围滑块拖动后地图不更新即此原因）。
 *   `reinit()` 是 QE 的公开 API，内部会 setupGL() 后直接 _redraw()，
 *   是当前版本唯一可靠的强制刷新入口；会重建 GL 资源，低频操作可接受。
 *
 * @param layer 已加入地图的像素图层
 */
function forceRedraw(layer: LPixelLayer): void {
  layer.reinit();
}

/**
 * 局部更新产品（多屏对比时切换产品用）。
 *
 * 数据源保存的是“按旧阈值 + 旧范围过滤后的副本”，因此过滤口径变化必须重建：
 *   - 阈值变化（变高或变低）→ 用【原始网格】按新阈值重建数据源：
 *       变高：补抹新增的弱值区间；
 *       变低：恢复旧阈值下被抹掉、但新阈值下应显示的值
 *             （旧实现只处理“变高”，导致切回低阈值产品后弱回波永久消失）。
 *   - 数值范围变化 → 同样必须重建（放宽范围要恢复被裁掉的值）。
 *   - 阈值与范围都没变（如 Z ↔ CR 共用同一套色标）→ 只替换绘制选项，省一次全量遍历。
 *
 * @param oldRange 当前数据源使用的范围（用于判断是否需要重建）
 * @param range    新范围；null/undefined 表示全范围
 */
export function updateRadarProduct(
  layer: LPixelLayer,
  grid: RadarGrid,
  oldThreshold: number,
  product: RadarProduct,
  smooth = false,
  range?: ValueRange | null,
  oldRange?: ValueRange | null
): void {
  const newThreshold = firstVisibleThreshold(product);
  const filtersChanged =
    newThreshold !== oldThreshold || valueRangeKey(range) !== valueRangeKey(oldRange);
  if (filtersChanged) {
    layer.setDataSource(createProvider(grid, newThreshold, range));
  }
  layer.setDrawOptions(buildDrawOptions(product, smooth) as never);
  // 数据/样式替换不会自动绘制，必须强制重绘一次（见 forceRedraw 说明）
  forceRedraw(layer);
}

/**
 * 仅数值范围变化（产品与色标不变）：重建数据源并强制刷新绘制选项。
 *
 * ★ 必须从原始网格重新过滤 ★
 *   旧数据源里已被裁掉的值无法恢复，只调 setDrawOptions 不会让它们重新出现。
 *
 * ★ 更新后必须 forceRedraw ★
 *   QE 的 setDataSource / setDrawOptions 只替换数据与样式，不会主动绘制；
 *   实测表现为“数据已换、画面还是旧的，直到缩放/拖动地图才更新”。
 *   必须调用 reinit() 强制重绘一次（见 forceRedraw 说明）。
 *
 * @param smooth 当前平滑开关（重建绘制选项时保持原模式）
 * @param range  新范围；null/undefined 表示全范围（恢复完整色标）
 */
export function updateRadarRange(
  layer: LPixelLayer,
  grid: RadarGrid,
  product: RadarProduct,
  smooth: boolean,
  range?: ValueRange | null
): void {
  layer.setDataSource(createProvider(grid, firstVisibleThreshold(product), range));
  layer.setDrawOptions(buildDrawOptions(product, smooth) as never);
  // 范围变化必须立即重绘，否则要等下一次地图交互才刷新
  forceRedraw(layer);
}

/**
 * 局部切换平滑/不平滑（数据与产品均不变，仅刷新填色模式）。
 * smooth=true → pixel1 双线性插值（平滑）；false → bitmap 格点填色（不平滑）。
 */
export function updateRadarSmooth(
  layer: LPixelLayer,
  product: RadarProduct,
  smooth: boolean
): void {
  layer.setDrawOptions(buildDrawOptions(product, smooth) as never);
  // 切换平滑同样只换样式不绘制，需强制重绘
  forceRedraw(layer);
}

/**
 * 查询网格中某经纬度点的数值（最近邻格点取值）。
 *
 * 坐标 → 格点索引的换算口径（全平台只此一处）：
 *   col = round((lon - xStart) / xDelta)
 *   row = round((lat - yStart) / yDelta)
 *   - RadarGrid 契约规定 xStart/yStart 是第 0 列/行【格点】的坐标，
 *     因此“四舍五入”等价于取最近格点中心，不是取像元左下角。
 *   - yDelta 为负（第 0 行在最北）时同样成立：分母为负，商自动反向。
 *   - Math.round 对负数按 floor(x + 0.5) 统一取整，无需额外补偿。
 *   - ⚠️ 已知遗留：若 QE bitmap 渲染的像元锚点与格点中心相差半格，
 *     会出现“点击值与色块差一档”。该假设需用真实数据比对渲染色档后
 *     才能定论，确认前不得擅自加 0.5 偏移（会把精度问题变成系统性偏移）。
 *
 * 阈值口径：渲染时低于产品首个可见阈值的格点是透明的，
 *   所以这里用同一阈值过滤，否则点击无回波区会弹出数值。
 *
 * @param grid       原始网格（渲染不再就地修改它，data 为未过滤的原始值）
 * @param lat        点击纬度
 * @param lon        点击经度
 * @param minVisible 显示阈值（firstVisibleThreshold(product)）；省略则不做阈值过滤
 * @param range      显示范围；范围外的格点在图上透明，取值同样返回 null
 * @returns 数值；越界 / 缺测 / 非有限值 / 低于阈值 / 范围外时返回 null
 */
export function sampleGridValue(
  grid: RadarGrid,
  lat: number,
  lon: number,
  minVisible?: number,
  range?: ValueRange | null
): number | null {
  const col = Math.round((lon - grid.xStart) / grid.xDelta);
  const row = Math.round((lat - grid.yStart) / grid.yDelta);
  if (col < 0 || col >= grid.xSize || row < 0 || row >= grid.ySize) return null;

  const v = grid.data[row * grid.xSize + col];
  if (v === grid.undef || !Number.isFinite(v)) return null;

  // 与渲染共用同一口径：阈值以下或范围外的值在图上透明，取值也返回 null
  if (!isValueVisible(v, minVisible, range)) return null;
  return v;
}

/**
 * 从地图移除雷达图层（时间切换重建前 / 组件卸载时调用）。
 */
export function removeRadar(map: LMap | null, layer: LPixelLayer | null): void {
  if (map && layer && typeof (map as unknown as { removeLayer?: unknown }).removeLayer === 'function') {
    (map as unknown as { removeLayer(l: unknown): void }).removeLayer(layer);
  }
}
