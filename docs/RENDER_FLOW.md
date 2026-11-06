# 产品渲染链路说明（点击产品 → 解码 → 渲染 → 值→颜色）

> 面向需要排查“为什么颜色不对 / 为什么画面不动 / 数据怎么变成色斑图”的开发者。
> 全部内容对应当前代码，改链路时请同步本文档。
> 相关文档：`docs/PRODUCT_GUIDE.md`（新增产品 / 改色标）、`docs/DEPLOY_GUIDE.md`（部署）。

---

## 0. 一句话总览

点击产品只改一个字段（`screen.productId`），**不重新下载数据**；
渲染链路是「产品（决定配色与阈值）+ 网格（决定数值）」两条线在
`renderRadar(map, grid, product, smooth, range)` 汇合，
最终把「分级色标规则 + 数值网格」交给 QuickEarth 的像素图层，
由 GL 按 `[档下限, 下一档下限)` 查表上色。

```
点击产品 ProductList.vue
   └─ setScreenProduct(id, productId)          ← store 只改 productId
        └─ useRadarScreen watch 触发 refresh()
             ├─ 同一时次已有图层 → 局部更新（换色标 / 重栅格化，不下载）
             └─ 无图层 / 换时次   → 取数 → 解码 → RadarGrid → renderRadar
                                                             │
   产品 RadarProduct.colorStops ─────────────────────────────┤
                                                             ▼
                                     buildColorRule / BitmapColorScaleGL
                                                             │
                                                    QE 像素图层逐格上色
```

数据侧与配色侧的分工：

| 对象 | 来源 | 决定什么 |
| --- | --- | --- |
| `RadarProduct` | `src/config/products.ts`（回退）/ `products.json`（优先） | 单位、显示阈值、分级色标（怎么画） |
| `RadarGrid` | `src/parse/*`（解码产物） | 经纬度网格 + 一维数值数组（画什么） |
| `ScreenState` | `src/store/appStore.ts` | 当前产品 / 时次 / 平滑 / 色标范围 / 仰角（每屏独立） |

---

## 1. 阶段一：点击产品之后发生了什么

### 1.1 只改状态，不动画面

```45:48:src/components/ProductList.vue
@click="
  setScreenProduct(appState.activeScreenId, p.id);
  setActiveScreen(appState.activeScreenId);
"
```

`setScreenProduct` 只写 `store.screens[].productId`。
产品元信息（色标）此时**不参与任何计算**，真正取用发生在渲染前：

```231:232:src/composables/useRadarScreen.ts
const product = getProductByIdSafe(sc.productId);
if (!product || !sc.time) return;
```

> `getProductByIdSafe` 先查服务器目录缓存，再回退静态 `PRODUCTS`，**永不返回 undefined**。

### 1.2 watch 触发 refresh

`useRadarScreen` 用一个拼串 watch 监听本屏 5 个可变量（产品 / 时次 / 平滑 / 色标范围 / 仰角）：

```641:658:src/composables/useRadarScreen.ts
watch(
  () => {
    const s = screen.value;
    return s ? s.productId + '|' + s.time + '|' + (s.smooth ? 1 : 0)
             + '|' + valueRangeKey(s.valueRange) + '|' + s.elevationIndex : '';
  },
  () => refresh()
);
```

### 1.3 refresh 的四个分支（顺序不可调换）

```
refresh()
 ├─ 图层存在 && 时次未变
 │    ├─ RSTM 体数据 && (仰角或产品变化) → volumeToGrid 重栅格化 → removeRadar + renderRadar
 │    ├─ 产品变化                        → updateRadarProduct（阈值/范围变了才重建数据源）
 │    ├─ 色标范围变化                    → updateRadarRange
 │    └─ 平滑开关变化                    → updateRadarSmooth
 └─ 否则需要取数
      ├─ 本地文件夹文件 → parseUploadedFile → applyParsedData → renderRadar
      ├─ 仅上传模式     → clearLayer（等用户上传）
      └─ 服务器数据
           ├─ 模板模式 buildFileMetaFromTemplate(tpl, time)  /  清单模式 files.find(time)
           │    └─ 找不到 → 「该时次无数据」
           ├─ format==='rstm' → fetchRstmVolume → volumeToGrid
           │                    解析不出体数据 → 回退 fetchRadarGrid（合成兜底）
           └─ 其他            → fetchRadarGrid → 解析器
                                → renderRadar + fitToGrid
```

关键点：

- **局部更新分支必须排在文件解析之前**：上传数据的文件不在服务器清单里，先查清单会把上传画面清成“该时次无数据”。
- **切换产品不重新下载**：非体数据只换色标；RSTM 体数据因为「仰角层 + 字段」共同决定栅格内容，必须重新 `volumeToGrid`（仍然复用已解析的 `RstmVolume`，不重新解压 36MB）。
- **并发保护**：每次 refresh 自增 `refreshToken`，`await` 之后 token 不等即丢弃结果；同时在途请求 `abort()`。

---

## 2. 阶段二：取数（数据是怎么到内存的）

入口：`src/api/radarApi.ts`

```
fetchRadarGrid(meta, productId, signal)
  ├─ 1. gridCache 命中 → 直接返回（多屏/播放共享同一个 grid 对象，必须只读）
  ├─ 2. 同键请求在途 → joinSharedTask（4 屏同步只下载解析一次，各自可独立取消）
  └─ 3. 否则 → loadGrid(meta, productId) → 成功后写入 LRU
```

- 缓存键 = `binFile|productId`（解析结果依赖产品），LRU 12 条 / 160MB。
- 体数据另走 `fetchRstmVolume`：LRU 3 份 / 384MB，键 = `binFile`；非体数据文件进负缓存，避免每次切时次重复试解析。

真正的下载与解码在 `src/api/radarSource.ts`：

```
loadGrid
  ├─ takeFallbackBuffer（复用体数据解析失败时已解压的 buffer，避免二次下载）
  ├─ fetchAndDecompress
  │    ├─ fetchWithTimeout(resolveDataUrl(binFile))     ← 统一 10s 超时
  │    ├─ 404 → RadarFileMissingError（UI 提示“该时次无数据”）
  │    └─ .bz2 → isBzip2Data 校验魔数 → decompressBzip2（seek-bzip，浏览器端解压）
  ├─ detectFormat（按内容魔数，不看扩展名）
  └─ 分派解析器 → RadarGrid
```

> 格式识别只看内容：`RSTM` → rstm、`SWAN` → mosaic、首行 `diamond 4` → m4；
> 都不匹配才回退清单里的 `format` / 文件名推断。
> 这样 bz2 解压前不知道真实格式、清单写错格式时也不会解析错文件。

---

## 3. 阶段三：解码（三种格式 → 统一的 RadarGrid）

### 3.1 统一的输出契约（`src/types/index.ts`）

```ts
RadarGrid {
  xStart, xDelta, xSize   // 经度方向：第 0 列经度 + 格距 + 列数
  yStart, yDelta, ySize   // 纬度方向：第 0 行纬度 + 格距（可为负）+ 行数
  data: Float32Array      // 行优先，索引 row * xSize + col
  undef: number           // 缺测哨兵，全平台统一 UNDEF = 999999
  isSynthetic?: boolean   // true = 没能真实解码，画面是合成示意数据
}
```

- `yDelta < 0` 表示**第 0 行在最北**，行号换算 `row = (lat - yStart) / yDelta` 对正负均成立。
- 解析器只负责“数值 + 地理参考”，**配色一概不知道**（这是渲染层的事）。

### 3.2 SWAN 拼图（`parse/mosaicParser.ts`）

| 项 | 口径 |
| --- | --- |
| 识别 | 头部 ASCII `"diamond"`（1024 字节头） |
| 头部字段 | 偏移 66~74 年月日时分（UTC）；78/80/82 格点数 X/Y/层数 Z；88/92 起始经纬度；104/108 格距 |
| 选层 | 默认第 2 层（约 1.5km CAP 层，最低层常因波束几何破碎） |
| 每样本字节数 | 由 `(文件长度-1024) / (X*Y*Z)` 推断 |
| 1 字节 | 缺测 = 255；`dBZ = (原始码 - 66) × 0.5` |
| 2 字节 | Int16，缺测 = 9999；物理值 = 原始值 |
| 地理 | `xStart=起始经度, xDelta=经度格距, yStart=起始纬度, yDelta=-纬度格距`（第 0 行在北，不翻转行序） |

> 注意：无回波区常被编码成原始码 0 → 解码后是 **-33 dBZ 的有效值**，不是缺测。
> 这正是后文「渲染前必须按阈值遮蔽」的直接原因。

### 3.3 MICAPS 第 4 类（`parse/micapsM4Parser.ts`）

- 文本格式，首行 `diamond 4`；判定必须在 mosaic 之前（两者都以 `diamond` 开头）。
- 头部 19 个数值字段给出格点数 / 起止经纬度 / 格距；数据体按行优先，先纬向后经向。
- 缺测 `9999` → 统一映射成 `UNDEF`（`M4_UNDEF_RAW` 只是文件内的表示）。
- 纬度格距原样透传（常规为负 → 第 0 行在北）。

### 3.4 CINRAD RSTM 基数据（`parse/cinradVolume.ts` 门面）

分两步，**先解析、再栅格化**：

**第一步：二进制 → 体数据（`rstmRadials.parseRstmVolume`）**

- 魔数 `RSTM`，结构校验失败返回 `null`（调用方回退单层合成兜底）。
- 布局：GENERIC(32) + SITE(128) + TASK(256) + CUT×N(256) → 径向（头 64）+ 矩（头 32 + 数据）。
- 解码公式：`value = (code - Offset) / Scale`；`code <= 4` 视为缺测。
- 距离库：Bin Length 1 → 8 位；2 → 16 位。
- 径向速度 V 按该 cut 的 Nyquist 折叠到 `[-n, n)`（与服务端 m4 产品对齐）。
- 长短圈按方位合并：逐字段保留“库数更多者”（长圈有 dBZ 到 460km、短圈才有 V/W 到 230km）。
- 产物 `RstmVolume = { lat, lon, elevations[], layers[][], gateSizes[], maxRanges[], ... }`。

**第二步：极坐标 → 等经纬度网格（`rstmGrid.volumeToGrid`）**

```
volume + layerIndex + field
  ├─ 字段映射：fieldForProduct(productId)  ← 产品 id 即 RSTM 字段名
  ├─ 覆盖范围：该层所有有效库的经纬度包围盒（超出 maxRange 的残留库忽略）
  ├─ 网格：0.01°（约 1km），第 0 行在最北
  ├─ 逐格点：经纬度 → (方位角, 地面距离)
  │    ├─ findNearestRadialIndex：找该字段“有数据”的最近方位径向
  │    ├─ groundToSlantFast：地面距离 → 沿波束斜距（按仰角缓存的 100m LUT）
  │    └─ 取库值，缺测时在 ±2 方位 / ±4 库内邻域回找（不超越数据自身分辨率）
  └─ 结果按 volume 单条缓存（键 = 层索引|字段），多屏同层同字段直接复用
```

> `volumeToGrid` 返回的 grid 是**只读共享对象**：禁止修改 `data` / `time`。

### 3.5 解码失败时

`parseRSTM`（单层合成兜底）永不抛错，返回 `isSynthetic = true` 的合成网格；
UI 依据 `grid.isSynthetic` 在屏头挂红色「示意数据」标记（禁止用于业务判断）。
取数链路的其他失败：404 → 「该时次无数据」；其余（含超时）→ 「加载失败」。

---

## 4. 阶段四：渲染（`src/render/radarRenderer.ts`）

`renderRadar(map, grid, product, smooth, range)` 内部 5 步：

```207:214:src/render/radarRenderer.ts
const threshold = firstVisibleThreshold(product);
const provider = createProvider(grid, threshold, range);

const layer = new LPixelLayer();
layer.setDrawOptions(buildDrawOptions(product, smooth));
layer.setDataSource(provider);
(map as ...).addLayer(layer);
```

步骤顺序：① 算阈值 → ② 副本过滤 → ③ 构造数据源 → ④ 构造绘制选项 → ⑤ 建图层入图。

### 4.1 第 1 步：算“首个可见阈值”

```74:77:src/render/radarRenderer.ts
export function firstVisibleThreshold(product: RadarProduct): number {
  const first = product.colorStops.find((s) => s.stop[3] > 0);
  return first ? first.value : Number.NEGATIVE_INFINITY;
}
```

即色标里**第一个 alpha > 0 的档位值**（透明兜底档不算）：反射率是 5 dBZ、速度是 -30 m/s。
低于它的格点在业务上就是“无回波 / 无数据”，图上应透明。

### 4.2 第 2 步：在**副本**上过滤数值

```94:111:src/render/radarRenderer.ts
function buildDisplayValues(data, undef, threshold, range) {
  if (!Number.isFinite(threshold) && !range) return data.slice();
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const masked = v !== undef && !isValueVisible(v, threshold, range);
    out[i] = masked ? undef : v;
  }
  return out;
}
```

- 被遮蔽的格点写成缺测哨兵 → QE 对缺测格点直接透明。
- **绝不修改 `grid.data`**：原数组保持完整，切产品 / 调范围时才能按新口径重新过滤（就地修改会让弱回波永久丢失）。

### 4.3 第 3 步：包装成 QE 格点数据源

```132:142:src/render/radarRenderer.ts
const gd = new GridData(GridDataType.Float32, grid.xSize, grid.ySize,
                        values, grid.undef, 0 /* algo=原始值 */, 1, 1, false);
```

```146:157:src/render/radarRenderer.ts
const gridOptions = { xStart, xDelta, xSize, yStart, yDelta, ySize };
ensureGridDataOptions(gridOptions);
return new MemoryGridDataProvider([[gd]], { gridOptions });   // [[gd]] = 单时次单字段
```

`new GridData(...)` 的参数含义：数据类型 / 列数 / 行数 / 数据 / 缺测值 / 算法 / scale / offset / createEmpty。
`algo = 0` 表示数据已是物理值，不再做 `(raw + offset) * scale` 变换。

### 4.4 第 4 步：构造分级填色规则 + 位图色例

```169:186:src/render/radarRenderer.ts
function buildDrawOptions(product, smooth) {
  const rule = buildColorRule(product);          // { fieldName:'0', stops:[{value, stop:[r,g,b,a]}] }
  const width = product.colorStops.length * 16;  // 每档 16px 纹理，保证采样精度
  const colorScale = BitmapColorScaleGL.createFromStopRules(
    rule, width, false /* 分级平色 */, 0, product.colorStops.length - 1
  );
  return {
    fillColor: rule,
    colorScale,
    fillMode: smooth ? GridDataGLFillMode.pixel1 : GridDataGLFillMode.bitmap,
    optimizedInterp: false                       // 关闭插值优化，避免缺测边界渗出过渡色
  };
}
```

- `gradient = false` → **分级平色**，不做颜色渐变。
- `colorScale`（bitmap 模式的正规配置，优先级高于 `fillColor`）与 `fillColor` 由同一套 stops 生成，保证两者一致。

### 4.5 第 5 步：加入地图

`LPixelLayer` 是 QE（Leaflet 变体）的像素图层，`map.addLayer(layer)` 会触发一次绘制。

**后续任何局部更新都必须强制重绘**：

```231:233:src/render/radarRenderer.ts
function forceRedraw(layer: LPixelLayer): void {
  layer.reinit();   // QE 的 GL 图层没有持续渲染循环
}
```

`updateRadarProduct` / `updateRadarRange` / `updateRadarSmooth` 末尾都调用它；
否则表现为“数据已换、画面还是旧的，缩放或拖动地图才刷新”。

---

## 5. 阶段五：值 → 颜色 的判定路径

### 5.1 平台交给 QE 的是什么

平台**不在 JS 里算颜色**，只提供两样东西：

1. 一张「阈值 → RGBA」的规则表 `colorStops`（严格升序）；
2. 由该规则生成的色例纹理 `BitmapColorScaleGL`。

逐像素的「数值落在哪一档 → 取哪个 RGBA」由 QE 的 GL 着色器查纹理完成。

### 5.2 分档语义

`colorStops` 每项 `{ value, stop: [r,g,b,a] }`，`value` 是**该档下限**，区间左闭右开：

```
value ∈ [stops[i].value, stops[i+1].value)  →  颜色 stops[i].stop
value >= 最后一档                            →  最后一档颜色
value <  第一档（透明兜底档）                →  第一档颜色（QE 钳位行为）
value === grid.undef（缺测）                 →  透明
```

反射率示例（`src/config/products.ts`）：

| 数值范围 | 颜色 |
| --- | --- |
| `[-100, 5)` | 透明（首档兜底，alpha = 0） |
| `[5, 10)` | 中蓝 `66,118,255` |
| `[10, 15)` | 浅青蓝 |
| `[20, 25)` | 绿 |
| `[35, 40)` | 黄 |
| `[50, 55)` | 红 |
| `[75, +∞)` | 淡粉 |

### 5.3 「蓝色底色」问题的两重保险

QE 的 bitmap 模式会把**低于首档**的值钳位到第一档颜色。若第一档不透明，整幅网格会被刷成第一档颜色（典型现象：全屏蓝色底）。

1. **色标首档必须是低 value + alpha = 0 的透明兜底档**（`{ value: -100, stop: [0,0,0,0] }`，速度类用 -1000）。
2. **渲染前把低于 `firstVisibleThreshold` 的值置为缺测**（见 4.2），走“缺测透明”这条最可靠路径。

两重保险缺一不可：只做①时，负值很大的格点仍会落进兜底档并被钳成第一档可见色；只做②时，色标本身不满足 QE 配置规范。

### 5.4 平滑 / 不平滑

| 模式 | `fillMode` | 行为 |
| --- | --- | --- |
| 不平滑（默认） | `GridDataGLFillMode.bitmap` | 每个格点按自身数值落档平铺，保留雷达原始分级色块观感 |
| 平滑 | `GridDataGLFillMode.pixel1` | 先对格点值做双线性插值，再经同一套分档取色，边界过渡平滑 |

两种模式共用同一套色标与缺测处理，屏头可逐屏切换；切换走 `updateRadarSmooth`（只换绘制选项 + 重绘，不重建图层）。

### 5.5 色标显示范围（图例双滑块）

范围语义 `[min, max)`，上界取“结束档的下一档值”（选 20~50 档 → `max = 55`），
与分档 `[v_i, v_{i+1})` 完全一致。

- 换算只在 `src/utils/range.ts`：`rangeFromStopIndex` / `stopIndexFromRange`；
- 范围外格点在 `buildDisplayValues` 里被置为缺测 → 图上透明（不是画成别的颜色）；
- 范围变化必须**从原始网格重新过滤**（放宽范围要恢复被裁掉的值），走 `updateRadarRange`。

### 5.6 三条更新路径的差异

| 变化 | 函数 | 是否重建数据源 | 是否重建图层 |
| --- | --- | --- | --- |
| 产品（阈值/范围未变） | `updateRadarProduct` | 否（只 `setDrawOptions`） | 否 |
| 产品（阈值或范围变了） | `updateRadarProduct` | 是 | 否 |
| 色标范围 | `updateRadarRange` | 是 | 否 |
| 平滑开关 | `updateRadarSmooth` | 否 | 否 |
| 时次 / RSTM 仰角 / 字段 | `renderRadar`（先 `removeRadar`） | 是 | 是 |

> 判据：**数据源里存的是“已按阈值 + 范围过滤后的副本”**，
> 过滤口径一变就必须重建数据源；只换颜色则 `setDrawOptions` 即可。

---

## 6. 取值与渲染的同源口径

渲染把不可见值置为缺测，取值也必须用同一口径，否则会出现“图上透明、点击却有数”。

```
地图 click → showValueAt(lat, lon)            （useRadarScreen）
           └─ queryValue(...)                 （parse/valueQuery.ts，纯函数）
                ├─ 原始值：RSTM 走 sampleRstmValue（极坐标原始径向，无网格量化）
                │          其余走 sampleGridRaw（栅格最近邻）
                ├─ 9 点均值：sampleRstmNeighborhood（仅 RSTM）
                └─ 可见性：sampleGridValue(grid, lat, lon, firstVisibleThreshold(product), range)
                             └─ isValueVisible（utils/range.ts）← 渲染层用的同一个函数
```

- 栅格索引换算（全平台唯一实现 `utils/gridSample.gridIndex`）：
  `col = round((lon - xStart) / xDelta)`、`row = round((lat - yStart) / yDelta)`。
- 图上透明时**仍然给出数值 + 原因**（“低于显示阈值 5 dBZ” / “超出当前色标范围”），而不是笼统的“无数据”。

---

## 7. 排障速查表

| 现象 | 优先怀疑 |
| --- | --- |
| 点产品后画面无任何变化 | watch 拼串是否含 `productId`；`refresh` 判重是否误跳过（`layerProductId`） |
| 换产品后颜色对了、数据没变（RSTM） | 是否漏了 `volumeToGrid(volume, elevationIndex, fieldForProduct(...))` 重栅格化 |
| 数据已换、画面要缩放/拖动才刷新 | 局部更新末尾是否调 `forceRedraw`（`reinit()`） |
| 整幅蓝色/单色底 | 首档是否缺透明兜底档；`buildDisplayValues` 是否生效 |
| 切回低阈值产品后弱回波永久消失 | 有代码就地改了 `grid.data`（渲染层必须用副本） |
| 点击值与色块差一档 | `sampleGridValue` 与 QE 像元锚点的半格偏移（已知遗留，确认前禁止加 0.5 偏移） |
| 屏头出现「示意数据」 | 解码失败走合成兜底（`isSynthetic`）；查文件魔数 / 数据区长度 |
| 切时次后空白且提示无数据 | 模板地址 404 或清单无该时刻；`noDataStatus` 会给最近可用时次 |
| 播放卡住 / 屏永久“加载中…” | `loading` 未清 / AbortError 未处理（禁止比较 status 文案） |
| 切换仰角无响应 | 判重条件是否比较 `elevationIndex`（且只在体数据下比较） |

---

## 8. 想自己调渲染方法

最小可用示例（不经过组件）：

```ts
import { renderRadar, removeRadar } from './render/radarRenderer';
import { getProductById } from './config/products';

const product = getProductById('dBZ')!;
const layer = renderRadar(map, grid, product, /* smooth */ false, /* range */ null);
// 之后：removeRadar(map, layer) 清理
```

改动约定：

- 新增产品 → 只加 `PRODUCTS` 一项（含透明兜底档），链路其余部分零改动；
- 新增格式 → 在 `src/parse/` 写解析器输出 `RadarGrid`（`undef = UNDEF`），
  在 `radarSource.detectFormat` 加魔数、在 `loadGrid` 加分派；
- 修改色标 → 只改 `colorStops`（严格升序、RGBA 0~255、首档透明、至少一个 alpha > 0）。
