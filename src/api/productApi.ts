/**
 * api/productApi.ts —— 获取产品列表的接口（产品列表数据源）
 *
 * ────────────────────────────────────────────────────────────────────────
 * 接口约定：
 *   fetchProductList(): Promise<RadarProduct[]>
 *     返回平台支持的雷达产品目录（以反射率为首）。
 *
 * 当前实现：前端静态目录（src/config/products.ts）。
 * 如后续接入真实后端，只需把本函数实现改为 fetch('/api/products')
 * 并把响应映射为 RadarProduct[] 即可，调用方（store / 组件）无需任何改动。
 * ────────────────────────────────────────────────────────────────────────
 */

import type { RadarProduct } from '../types';
import { getProductList as getStaticProducts } from '../config/products';

/**
 * 获取产品列表。
 * @returns 产品目录（Promise 包装，保持与后端版本一致的异步签名）
 */
export async function fetchProductList(): Promise<RadarProduct[]> {
  // TODO(后端接入示例)：
  //   const resp = await fetch('/api/radar/products');
  //   if (!resp.ok) throw new Error('获取产品列表失败：HTTP ' + resp.status);
  //   return await resp.json();
  return getStaticProducts();
}

/**
 * 按产品代码查找产品元信息（同步便捷方法）。
 * @param id 产品代码，如 'Z'
 */
export function findProduct(id: string): RadarProduct | undefined {
  return getStaticProducts().find((p) => p.id === id);
}
