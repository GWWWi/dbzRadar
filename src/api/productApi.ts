/**
 * api/productApi.ts —— 获取产品列表的接口（产品列表数据源）
 *
 * ────────────────────────────────────────────────────────────────────────
 * 接口约定：
 *   fetchProductList(): Promise<RadarProduct[]>
 *     优先从服务器获取产品目录 JSON（地址可用 setProductUrl 指向服务器
 *     任意目录，相对路径或跨域绝对 URL 均可）；获取失败或格式非法时
 *     回退到前端内置静态目录（src/config/products.ts），保证应用可用。
 *
 *   findProduct(id): RadarProduct | undefined
 *     先在最近一次成功加载的服务器目录中查找，再回退静态目录。
 *
 * 服务器产品文件格式（JSON 数组，字段与 RadarProduct 对应）：
 *   [
 *     { "id": "Z", "name": "基本反射率", "unit": "dBZ", "type": "obs",
 *       "colorStops": [ { "value": -100, "stop": [0,0,0,0] }, ... ] }
 *   ]
 *   约定：type 为实况 obs / 预报 fcst（缺省按 obs）；colorStops 按 value
 *   升序，首档必须是低 value + alpha=0 的透明兜底档。
 * ────────────────────────────────────────────────────────────────────────
 */

import type { ColorStop, RadarProduct } from '../types';
import {
  getProductList as getStaticProducts,
  getProductById as getStaticProductById
} from '../config/products';
import { fetchWithTimeout } from '../utils/http';

/** 服务器产品目录地址（默认站点 /data/products.json，可用 setProductUrl 改指向） */
let productUrl = 'data/products.json';

/** 最近一次成功加载的产品目录缓存（供 findProduct 同步查找） */
let loadedProducts: RadarProduct[] | null = null;

/**
 * 设置服务器产品目录地址（相对站点根的路径或任意服务器的绝对 URL）。
 * 切换地址后会清空已加载缓存，下次 fetchProductList 重新拉取。
 */
export function setProductUrl(url: string): void {
  productUrl = url;
  loadedProducts = null;
}

/**
 * 校验并规整服务器返回的单个产品项；字段缺失或类型非法时返回 null。
 * stop 各分量强制转数字，非有限数视为非法。
 */
function normalizeProduct(raw: unknown): RadarProduct | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (!Array.isArray(r.colorStops) || r.colorStops.length === 0) return null;
  const colorStops: ColorStop[] = [];
  // 色标必须严格升序：它是区间填色的分档阈值，乱序/重复会让档位错乱
  let prevValue = Number.NEGATIVE_INFINITY;
  // 至少要有一个 alpha>0 的档，否则任何数据都不会被着色
  let hasVisible = false;

  for (const s of r.colorStops) {
    if (!s || typeof s !== 'object') return null;
    const { value, stop } = s as Record<string, unknown>;
    // NaN 也是 number，必须用 isFinite 过滤，否则升序比较会失效
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (!Array.isArray(stop) || stop.length !== 4) return null;

    const rgba = stop.map(Number);
    // RGBA 各分量必须是 0~255 的有限数
    if (rgba.some((c) => !Number.isFinite(c) || c < 0 || c > 255)) return null;
    if (value <= prevValue) return null;
    prevValue = value;
    if (rgba[3] > 0) hasVisible = true;

    colorStops.push({ value, stop: [rgba[0], rgba[1], rgba[2], rgba[3]] });
  }

  // 全透明色标 = 产品永远不显示数据，视为配置错误
  if (!hasVisible) return null;

  // 首档透明兜底（软校验）：缺失时不拒绝整表，只告警——
  // 渲染层还有“低于首档可见阈值置缺测”的兜底，但配置方应补齐该档。
  if (colorStops[0].stop[3] > 0) {
    console.warn(
      '[productApi] 产品 ' + r.id + ' 的色标首档不透明，建议补一个低值 alpha=0 的兜底档'
    );
  }

  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : r.id,
    unit: typeof r.unit === 'string' ? r.unit : '',
    type: r.type === 'fcst' ? 'fcst' : 'obs', // 缺省/非法值按实况产品处理
    colorStops
  };
}

/**
 * 获取产品列表。
 * 流程：fetch 服务器 JSON → 逐项校验规整 → 缓存并返回；
 * 任一环节失败（404/网络/格式非法）→ 回退内置静态目录（console.warn 提示）。
 * @returns 产品目录（Promise 包装，保持与后端版本一致的异步签名）
 */
export async function fetchProductList(): Promise<RadarProduct[]> {
  try {
    // 超时视为加载失败 → 回退内置静态目录（保证应用可用）
    const resp = await fetchWithTimeout(productUrl);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const raw = (await resp.json()) as unknown;
    if (!Array.isArray(raw)) throw new Error('产品目录必须是 JSON 数组');
    const list = raw.map(normalizeProduct);
    if (list.some((p) => p === null)) throw new Error('产品目录存在非法项（缺 id/colorStops 或色标格式错误）');
    loadedProducts = list as RadarProduct[];
    return loadedProducts;
  } catch (e) {
    console.warn('[productApi] 服务器产品目录(' + productUrl + ')加载失败，回退内置静态目录：', e);
    loadedProducts = null;
    return getStaticProducts();
  }
}

/**
 * 按产品代码查找产品元信息（同步便捷方法）。
 * 先查最近一次服务器加载的目录，未加载/未命中时回退静态目录。
 * @param id 产品代码，如 'Z'
 */
export function findProduct(id: string): RadarProduct | undefined {
  return loadedProducts?.find((p) => p.id === id) ?? getStaticProductById(id);
}
