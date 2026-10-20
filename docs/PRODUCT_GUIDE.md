# 雷达产品开发指南

本文档面向需要在平台中**新增雷达产品**、**调整产品配色**或**独立调用渲染方法**的开发者。

---

## 1. 核心概念与整体数据流

```
src/config/products.ts          产品静态目录（id/name/unit/colorStops）
        │ getProductList()
        ▼
src/api/productApi.ts           fetchProductList() ──► src/store/appStore.ts (setProducts)
        │                                                  │
        │                                                  ▼
        │                                    左侧 ProductList 展示 / RadarScreen 消费
        ▼
src/api/radarApi.ts             fetchRadarFileList() → manifest.json 文件清单
                                fetchRadarGrid(meta, productId) → 分派解析器
        │
        ▼
src/parse/*                     mosaic / rstm / m4 三种格式统一解析为 RadarGrid
        │
        ▼
src/render/radarRenderer.ts     renderRadar(map, grid, product, smooth, range) → QuickEarth LPixelLayer 色斑图
```

- **产品（RadarProduct）** 决定"怎么画"：单位、分级色标。
- **网格（RadarGrid）** 决定"画什么"：经纬度网格 + 行优先一维数值数组。
- 渲染采用 QE `bitmap 格点填色` 模式：逐格按数值落档平铺颜色，**不做插值平滑**。

---

## 2. 产品数据结构

定义位于 `src/types/index.ts`：

```ts
interface RadarProduct {
  id: string;            // 产品代码，如 'Z'（唯一键）
  name: string;          // 中文名，显示在左侧产品列表
  unit: string;          // 数值单位，如 'dBZ' / 'km' / 'm/s'
  type: 'obs' | 'fcst';  // 资料类型：实况 obs（默认）/ 预报 fcst，列表带类型标签
  colorStops: ColorStop[]; // 分级色标
}

interface ColorStop {
  value: number;                          // 该档的下限阈值（升序排列）
  stop: [number, number, number, number]; // RGBA，取值 0~255
}
```

---

## 3. 如何添加新产品

### 步骤 1：在产品目录中注册

编辑 `src/config/products.ts`，向 `PRODUCTS` 数组追加一项即可，左侧产品列表会自动展示：

```ts
{
  id: 'VIL',                    // 唯一产品代码
  name: '垂直液态水含量',         // 列表显示名
  unit: 'kg/m²',                // 图例/弹窗中的单位
  type: 'obs',                  // 资料类型：实况 obs / 预报 fcst
  colorStops: [
    { value: -100, stop: [0, 0, 0, 0] },      // ★ 首档必须为透明兜底档（见第 4 节）
    { value: 0.5,  stop: [166, 242, 143, 255] },
    { value: 1,    stop: [61, 186, 61, 255] },
    { value: 2,    stop: [253, 221, 92, 255] },
    { value: 4,    stop: [240, 140, 40, 255] }
  ]
}
```

规则与注意事项：

1. `id` 必须唯一；数组顺序即列表展示顺序，**第 0 个产品是多屏的默认产品**。
2. 新产品若与现有产品配色一致，直接复用现有色标函数（如 `reflectivityColorStops()`）。
3. 添加后无需改动任何组件/store——`appStore.setProducts()` 与 `getProductByIdSafe()` 会自动生效。

### 步骤 2（仅当新产品需要专门的数据源/解析逻辑时）

`fetchRadarGrid(meta, productId)` 目前把所有文件解析为反射率类网格。若新产品来自不同字段或文件格式：

1. 在 `src/parse/` 下新增解析器（输出统一的 `RadarGrid`）；
2. 在 `src/api/radarApi.ts` 的 `fetchRadarGrid()` 中按 `meta.format` / `productId` 分派；
3. 如需新的文件类型，同步扩展 `public/data/manifest.json` 清单与 `RadarFileFormat` 类型。

仅新增"同一数据的另一种配色/单位表达"（如组合反射率之于基本反射率）时，**只需步骤 1**。

---

## 4. 如何修改产品色标

色标全部集中在 `src/config/products.ts`，直接修改对应产品的 `colorStops` 数组即可。

### 排列规则

- 按 `value` **升序**排列；渲染时格点落入"最后一个 ≤ 该值的档"，即每档是 `[value_i, value_{i+1})` 区间填 `stop_i` 颜色。
- `stop` 为 `[红, 绿, 蓝, 透明度]`，取值 0~255。

### ★ 必须保留首档"透明兜底档"★

```ts
{ value: -100, stop: [0, 0, 0, 0] }
```

QE bitmap 模式会把**低于首个可见阈值的值钳位到第一档颜色**。若首档不是透明档，
无回波/噪声底区域会被第一档颜色铺满整幅网格（历史踩坑："蓝色底色"问题）。
因此每个产品色标最前面都必须有一个 `value` 极低、`alpha=0` 的档位。

### 与显示阈值的联动

渲染层的 `firstVisibleThreshold(product)` 取**第一个 alpha>0 档位的 value** 作为显示阈值：

- 渲染时在数据副本上把低于该阈值的格点置为缺测（原始 `grid.data` 保持不变），这些格点透明、不参与点击取值；
- 修改色标时请保证兜底档 value 远低于业务有效最小值（如反射率用 `-100`）。

### 生效方式

- 开发模式（`npm run dev`）：保存即热更新。
- 运行中切换产品（同屏换色标）走 `updateRadarProduct()` 局部刷新，无需重建图层。

### 运行时色标显示范围（每屏独立）

图例上的两个手柄用于选择数值区间 `[min, max)`，范围外的格点渲染为透明、点击取值返回 null：

- 状态：`ScreenState.valueRange`（null=全范围），通过 `setScreenRange(screenId, range)` 修改；
- 渲染：`renderRadar(..., range)` / `updateRadarRange(...)` 按新范围重建数据副本；
- 换算：`src/utils/range.ts` 的 `rangeFromStopIndex` / `stopIndexFromRange`（档位索引 ↔ 数值范围）；
- 上界为开区间：选中 20~50 档对应 `{ min: 20, max: 55 }`（结束档的下一档值）。

---

## 5. 获取产品之后如何调用渲染

### 平台内部的完整调用链（参考 `src/components/RadarScreen.vue`）

```ts
// ① 启动时加载产品目录与文件清单（App.vue onMounted）
const products = await fetchProductList();   // api/productApi.ts
setProducts(products);

const files = await fetchRadarFileList();    // api/radarApi.ts（manifest.json）

// ② 单屏刷新（RadarScreen.refresh()）
const file = files.find((f) => f.time === time);
const grid = await fetchRadarGrid(file, productId);   // 解析为 RadarGrid

removeRadar(map, oldLayer);                  // 移除旧图层
// ★ 核心：渲染色斑图（smooth=是否平滑，range=色标范围，null 表示全范围）
const layer = renderRadar(map, grid, product, smooth, range);

// ③ 仅切换产品（时间不变）→ 只刷色标，不重建图层
updateRadarProduct(layer, grid, oldThreshold, newProduct, smooth, range, oldRange);

// ④ 销毁（组件卸载/时间切换前）
removeRadar(map, layer);
```

### 最小独立集成示例

在自己的页面中从零渲染一幅雷达色斑图：

```ts
import * as L from 'leaflet';
import { createRadarMap, applyBaseMap } from './render/mapManager';
import {
  renderRadar, removeRadar, sampleGridValue, firstVisibleThreshold
} from './render/radarRenderer';
import { fetchRadarFileList, fetchRadarGrid } from './api/radarApi';
import { getProductById } from './config/products';

// 地图与底图（admin=天地图；border=国界/省界矢量底图）
const map = createRadarMap(document.getElementById('map')!);
void applyBaseMap(map, 'admin');

// 取数 + 渲染
const files = await fetchRadarFileList();
const product = getProductById('Z')!;                 // 产品决定色标与单位
const grid = await fetchRadarGrid(files[0], 'Z');     // 网格决定数据
// ← 渲染就这一句（smooth=false 格点填色；range=null 全范围）
let layer = renderRadar(map, grid, product, false, null);

// 时间切换：先移除旧图层再重建
removeRadar(map, layer);
layer = renderRadar(map, await fetchRadarGrid(files[1], 'Z'), product, false, null);

// 可选：点击取值（返回 null 表示无数据 / 低于显示阈值 / 色标范围外）
map.on('click', (e: L.LeafletMouseEvent) => {
  const v = sampleGridValue(
    grid,
    e.latlng.lat,
    e.latlng.lng,
    firstVisibleThreshold(product),
    null
  );
});
```

### 渲染层 API 一览（`src/render/radarRenderer.ts`）

| 方法 | 用途 |
| --- | --- |
| `renderRadar(map, grid, product, smooth?, range?)` | 核心：渲染色斑图，返回 `LPixelLayer`；在副本上过滤弱值与范围外数值 |
| `updateRadarProduct(layer, grid, oldThreshold, product, smooth?, range?, oldRange?)` | 同一数据换产品（色标/范围）局部刷新；过滤口径变化时重建数据源 |
| `updateRadarRange(layer, grid, product, smooth, range)` | 仅色标范围变化时局部刷新 |
| `updateRadarSmooth(layer, product, smooth)` | 仅平滑模式变化时局部刷新 |
| `removeRadar(map, layer)` | 从地图移除图层 |
| `sampleGridValue(grid, lat, lon, minVisible?, range?)` | 经纬度 → 最近格点取值；无数据 / 低于阈值 / 范围外返回 `null` |
| `firstVisibleThreshold(product)` | 取产品首个可见阈值（首个非透明色标档） |

> 注意：渲染与局部更新都在**数据副本**上过滤，不会修改 `grid.data`；
> `fetchRadarGrid` 返回的网格可能来自缓存并被多屏共享，调用方必须只读。
