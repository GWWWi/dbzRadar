# AGENTS.md —— AI 开发上下文文档

> 本文档供各类 AI 编码助手（Claude/Codex/Cursor/opencode 等）快速建立项目认知。
> 内容为事实性速查，修改代码前请通读第 6 节"硬性约束"，完成后按第 7 节验证。

## 1. 项目一句话

二维雷达显示平台：把多种雷达数据格式解析为统一经纬度网格 RadarGrid，
用 QuickEarth(Leaflet) 以**不平滑的 bitmap 格点填色**渲染成分级色斑图，
支持产品列表 / 时间轴动画 / 多屏对比 / 点击取值。

## 2. 技术栈与命令

| 项 | 值 |
| --- | --- |
| 框架 | Vue 3.4（`<script setup lang="ts">`）+ Vite 5 + TS 5.4 + Element Plus（时间选择控件，html.dark 深色主题） |
| 地图 | QuickEarth 3.2.2（`@quickearth/core` + `@quickearth/leaflet`）+ Leaflet 1.9.4 |
| QE 地图类 | `LMap extends Leaflet L.Map`——Leaflet 的 on/popup/layer API 全部可用 |
| QE 初始化 | `src/main.ts`：先设 `consts.wasmPath='/libs/wasm'`、`workerPath='/libs/workers'`，再 `qeInit(undefined, true)` 免费二维模式 |
| dev | `npm run dev`（scripts/dev.cjs，端口 5179，strictPort） |
| build | `npm run build`（scripts/build.cjs） |
| 类型检查 | `npx vue-tsc --noEmit -p tsconfig.json`（★ 无测试框架，这就是唯一自动验证手段） |

## 3. 目录地图

```
index.html                     单页入口 #app
vite.config.ts                 public/ 原样拷贝：/libs/*（QE wasm/workers）、/data/*（雷达数据）
scripts/
  dev.cjs / build.cjs          启动/构建脚本（Node >=18）
  prepare-data.cjs             npm run prepare:data：bz2→bin 预解压 + 生成 manifest.json
public/data/
  manifest.json                文件清单：file/binFile/time/stationId/stationName/hasData/format
  products.json                服务器产品目录（可删除 → 回退内置静态目录）
  config.example.json          应用配置示例（部署时复制为 config.json 放服务器任意目录）
src/
  main.ts                      QE init + 挂载 Vue（含 Element Plus 样式与深色主题 css-vars，html.dark 已在 index.html 声明）
  App.vue                      布局编排 + 启动拉取 products/config/files + 播放定时器(800ms)
  styles.css                   全局深色主题样式
  constants.ts                 ★ 跨层常量：统一缺测哨兵 UNDEF
  mapBorder/                   ★ 国界底图数据：worldGJ(179 国) / chinaGJ(全国) / chinaSJ(42 省)，合计约 4MB
  utils/datetime.ts            ★ 时间格式转换唯一实现：msToISO/msToText/isoToMs/isoToCompact/compact12ToISO/digits14ToISO
  utils/http.ts                ★ fetchWithTimeout（默认 10s）+ FetchTimeoutError：所有网络请求统一走这里
  utils/range.ts               ★ 色标范围：isValueInRange/isValueVisible/valueRangeKey/rangeFromStopIndex/stopIndexFromRange（渲染、取值、图例共用同一口径）
  types/index.ts               ★ 数据契约（唯一类型源）：ColorStop/RadarProduct/RadarProductType/RadarFileMeta/RadarGrid/AppConfig/TimelineConfig
  config/products.ts           内置产品静态目录 PRODUCTS（服务器产品目录的回退）+ 色标函数 reflectivityColorStops()
  api/productApi.ts            fetchProductList()（服务器 products.json → 失败回退静态）/findProduct(id)/setProductUrl(url)
  api/configApi.ts             fetchAppConfig()（config.json，缺失回退清单模式）/setConfigUrl(url)/buildTimelineTimes(cfg, anchorMs?) 时间轴生成
  api/radarApi.ts              fetchRadarFileList(url?)/buildFileMetaFromTemplate(template,time)/parseUploadedFile(file,productId) 上传文件格式识别/RadarFileMissingError(404)/fetchRadarGrid(meta, productId) 分派解析器（LRU 缓存 12 条 + 在途请求合并，返回共享 grid 对象，只读）
  parse/mosaicParser.ts        SWAN 拼图 "diamond" 头：isRADAMOSAIC()/parseRADAMOSAIC()
  parse/cinradParser.ts        CINRAD 单站 RSTM："RSTM" 魔数：parseRSTM()（体数据不可解码，恒为合成团块；isSynthetic 恒 true，头部只提供站点定位）
  parse/micapsM4Parser.ts      MICAPS 第4类文本：isMicapsM4()/parseMicapsM4()
  render/mapManager.ts         createRadarMap(el)/applyBaseMap(map,mode)/applyBaseMapToAll(mode)（admin=天地图 vec_w+cva_w；border=国界矢量：陆地 #efefdb、海洋 #97b6e1、界线 #606266，世界/中国 1px、省界 0.8px，按需加载 mapBorder 三份 GeoJSON）/setMapLink/registerMapLink/unregisterMapLink（多屏联动，move 经 rAF 合并）
  render/radarRenderer.ts      ★ 核心：renderRadar(smooth,range)/updateRadarProduct/updateRadarSmooth/updateRadarRange/removeRadar/sampleGridValue/firstVisibleThreshold
  store/appStore.ts            Vue reactive 单例全局状态 + mutations（setLayout/setScreenProduct/setScreenSmooth/setScreenRange/setScreenTime/setFiles/setProducts/setPlaying/setSyncPlay/setSyncMap/setActiveScreen/setScreenStatus/setTimeline(times,template)/setTimelineConfig/getProductByIdSafe）+ 状态 timeline/fileUrlTemplate/timelineConfig + computed（activeScreen/timelineTimes：优先配置生成，回退 files 推导）；ScreenState.smooth / valueRange 均为每屏独立
  components/
    Toolbar.vue                布局切换(1/2/4/6屏)/同步开关/地图联动开关/播放按钮
    ProductList.vue            左侧产品列表（作用于激活屏）
    TimeAxis.vue               Canvas 刻度轴（样式参考 timeline-canvas）：拖拽左右任意平移（不触发取数），松手后吸附最近时次并 emit('change') 加载对应文件；点击跳转/滚轮缩放；顶条绿色刻度=有文件时次；受控组件；重绘经 rAF 合并，marks 升序二分只画可见区间
    Timeline.vue               底部时间轴（syncPlay 时广播全部屏；TimeAxis 刻度轴 + 上一/下一时次；Element Plus 控件：el-date-picker 选锚点（配置模式，预报起报/实况结束，改选重生成时间轴）+ el-date-picker 跳转时次（显示 YYYY-MM-DD HH:mm，值 YYYYMMDDHHmm，吸附最近可用时次））
    RadarScreen.vue            ★ 单屏容器：建图/watch 取数渲染/点击取值 popup/无文件提示“该时次无数据”/屏头平滑开关（每屏独立）/屏头上传按钮（每屏独立，格式识别后本屏渲染）/卸载销毁
    Legend.vue                 右下角色标浮层（可拖拽；每屏独立的色标范围：自绘双圆点手柄叠加在色标条上，只显示所选区间颜色，范围外透明）
```

## 4. 核心数据契约（src/types/index.ts）

### RadarGrid（解析输出 = 渲染输入）
- `x`=经度、`y`=纬度（度）；`xStart/xDelta/xSize`、`yStart/yDelta/ySize`
- `data: number[]` 行优先一维数组，长度 xSize*ySize，索引 `row*xSize+col`
- **`yDelta<0` 表示第 0 行在最北**（row=(lat-yStart)/yDelta 对正负均成立）
- `undef` 缺测哨兵（各解析器统一用 999999）；`isSynthetic=true` 表示合成兜底数据

### RadarProduct
- `{ id, name, unit, type, colorStops }`；id 唯一；PRODUCTS[0] 为多屏默认产品
- type：实况 obs / 预报 fcst（RadarProductType），服务器配置缺省按 obs；产品列表带类型标签
- ColorStop：`{ value: 下限阈值(升序), stop: [r,g,b,a](0~255) }`，区间填色 `[value_i, value_{i+1})`

### 取值一致性
renderRadar **不修改 grid.data**：渲染数据源内部使用“按当前阈值过滤后的副本”
（低于 `firstVisibleThreshold(product)` 的值在副本里置为 undef），原始网格保持完整，
切换产品时由 `updateRadarProduct` 用原始网格按新阈值重建数据源。
因此点击取值必须显式传阈值与范围
`sampleGridValue(grid, lat, lng, firstVisibleThreshold(product), screen.valueRange)`，
否则图上透明的区域（无回波 / 范围外）会弹出数值。

## 5. 关键调用链

```
启动:   App.onMounted → Promise.all([fetchProductList(), fetchAppConfig()])
        → setProducts + setTimelineConfig
        → config 存在: setTimeline(buildTimelineTimes(cfg)) 生成时间轴
          （有 fileUrlTemplate → 模板模式；无 → 再 fetchRadarFileList(cfg.fileListUrl)）
        → config 缺失: setFiles(fetchRadarFileList()) 清单回退模式（时间轴=清单时刻）

单屏:   RadarScreen.onMounted → createRadarMap + applyBaseMap(map, appState.baseMap) + registerMapLink + map.on('click')
        watch(productId|time|smooth) → refresh():
          文件解析: 模板模式 buildFileMetaFromTemplate(tpl, time)；
                    清单模式 files.find(time)，找不到 → 状态提示“该时次无数据”
          仅产品变(时间同) → updateRadarProduct(layer, grid, oldThreshold, product, smooth)
          仅平滑变(时间同) → updateRadarSmooth(layer, product, smooth)（bitmap↔pixel1 局部刷新）
          否则 → fetchRadarGrid(file, pid)（404 → RadarFileMissingError → “该时次无数据”）
                → removeRadar(旧) → renderRadar(map, grid, product, smooth)
                → fitToGrid(grid)：数据范围变化时自动定位（同区域切时次不重置视野）

点击:   map click → sampleGridValue(layerGrid, lat, lng, firstVisibleThreshold(product), screen.valueRange)
        → 有值: L.popup('.value-popup') 显示 `${v.toFixed(1)} ${unit}` + 经纬度(toFixed(3))
        → null: map.closePopup()

选锚点: Timeline 时间选择控件（配置模式）→ buildTimelineTimes(cfg, anchor) 重生成
        → setTimeline + setScreenTime 跳到锚点时次（syncPlay 广播全屏）

播放:   App.vue setInterval 800ms → setScreenTime(激活屏, 下一时次)（syncPlay 广播全屏）
```

## 6. 硬性约束与踩坑（违反必出 bug）

1. **色标首档必须透明兜底**：`{ value:-100, stop:[0,0,0,0] }`（速度产品用 -1000）。
   QE bitmap 模式把低于首阈值的值钳位到第一档颜色，无透明兜底档会出现整幅"蓝色底色"。
2. **compressjs 只能在 Node 用**：浏览器引入会因 amdefine 白屏崩溃。
   bz2 一律由 scripts/prepare-data.cjs 预解压成 .bin，前端只 fetch 解压后文件。
3. **渲染层禁止修改 grid.data**：`renderRadar` 在副本上过滤弱值。就地修改会让低阈值产品
   的弱值在切回时永久丢失（切产品 → 数据静默损坏）。
4. **QE 资源路径必须在 qeInit 前设置**（main.ts 已处理，勿动顺序）。
5. **缺测哨兵统一 999999**（SYNTH_UNDEF/UNDEF），新解析器必须遵守。
6. **多屏地图容器 id 必须唯一**：`'radar-map-' + screenId`。
7. **非响应式对象不进 reactive**：map/layer/grid 用普通变量保存（见 RadarScreen）。
8. **时间轴升序依赖** manifest.json 排序，radarApi 内已再 sort 双保险。
9. yDelta 可正可负，任何行号换算禁止假设"第 0 行在南"。
10. **时间轴与文件解耦**：配置模式时间轴按规则生成，时次未必有文件——
    清单模式找不到或模板模式 404 都必须提示"该时次无数据"，不得静默失败。
11. **fetchRadarGrid 返回的是共享缓存对象**：多屏/播放复用同一引用，任何调用方不得修改
    `grid.data` / `undef` / `time`（渲染层在副本上过滤弱值，取值只读）。
12. **时间轴时次上限 3000**：超限时 buildTimelineTimes 自动按整分钟放大间隔并 warn；
    默认 6 分钟 × 10 天 = 2401 档，该保护不得改变默认配置的行为。
13. **网络请求统一走 `utils/http.ts` 的 fetchWithTimeout**：原生 fetch 没有超时，
    网络半开会让屏永久停在“加载中…”并卡住播放（App 的加载中避让逻辑会一直跳过）。
14. **输入边界**：上传文件 ≤200MB；产品色标必须严格升序、RGBA 各分量 0~255、
    至少一个 alpha>0 档（首档不透明只告警不拒绝）。
    单幅网格点数**不设上限**（曾有 400 万点限制，已按需求取消）；超大网格仅由
    “数据区不足 / 数据 token 不足”的原有校验兜底。
15. **色标范围语义 [min, max)**：范围外格点渲染为透明、取值返回 null；上界为开区间，
    图例选“20~50 档”对应 max=55（结束档的下一档值）。索引↔数值换算只在 `utils/range.ts`，
    渲染层与图例不得各写一份。
16. **QE 图层更新后必须强制重绘**：`setDataSource` / `setDrawOptions` 只替换数据与样式，
    不会主动绘制（GL 图层没有持续渲染循环）。`renderRadar` 之后的所有局部更新
    （`updateRadarProduct` / `updateRadarRange` / `updateRadarSmooth`）末尾都要 `forceRedraw(layer)`
    （内部调 QE 公开 API `reinit()`）。否则表现为“数据已变、画面要等缩放/拖动地图才刷新”。
    新建图层的 `renderRadar` 不需要调用（`addLayer` 会触发绘制）。
17. **底图双模式**：`admin`=天地图瓦片；`border`=矢量（容器背景海洋色 + 世界/中国陆地填充 + 省界线）。
    矢量底图必须放在 `qe-base-border` pane（zIndex 190），否则会盖住雷达色斑图。
    边界数据用 `?url` 按需加载（约 4MB），**禁止改成静态 import** 打进主包；
    每张地图的切换有独立 token，异步加载回来时若已切走/卸载必须丢弃结果。

## 7. 分层规则与编码规范

- 依赖方向单向：`components → api/render → parse → types`；store 可被 components/api 之上所有层引用。
  禁止反向依赖（parse 不得 import api/render/components）。
- 注释：中文 JSDoc 风格，说明"为什么"；每个文件头部有一段职责总述。新增公共导出必须带注释。
- 命名：文件 kebab-case（ts）/PascalCase（Vue 组件）；CSS 类沿用 styles.css 现有 BEM-ish 风格。
- 类型集中放 types/index.ts，不在业务文件里重复定义领域模型。
- 时间格式转换统一走 `src/utils/datetime.ts`（ISO / 紧凑串 / 显示文本），业务文件禁止自写格式化；
  缺测哨兵统一用 `src/constants.ts` 的 `UNDEF`，禁止解析器各写一份。
- UI 全局样式进 src/styles.css（带分节注释横线），组件内尽量少写 scoped style。
- 保持现有代码风格：不改无关格式、不顺手重构。

## 8. 常见任务配方

### A. 新增产品（仅配色/单位不同）
在 src/config/products.ts 的 PRODUCTS 追加一项即可（含透明兜底档，标注 type 实况 obs/预报 fcst）。无需动其他层。

### B. 新增需要专门解析的产品
1. src/parse/ 新增解析器 → 输出 RadarGrid（undef=999999，永不抛错可用 buildSynthetic 兜底）
2. radarApi.fetchRadarGrid 按 format/productId 分派
3. 新文件类型：扩展 RadarFileFormat 类型 + manifest.json + guessFormat()

### C. 修改色标
只改 products.ts 对应产品的 colorStops（升序、RGBA 0~255、首档透明兜底）。
运行中切产品走 updateRadarProduct 局部刷新。

### D. 新增地图交互
参考 RadarScreen.vue 的 onMapClick：LMap 即 Leaflet Map，直接用原生事件/L.popup/L.marker。

### E. 接入真实后端
改 api 层三个入口即可，上层零改动：产品目录 setProductUrl(url)、应用配置 setConfigUrl(url)
（时间轴规则 + fileUrlTemplate 文件地址模板，{time} → yyyyMMddHHmmss）、清单 fetchRadarFileList(url)。

## 9. 完成定义（DoD）

- [ ] `npx vue-tsc --noEmit -p tsconfig.json` 通过
- [ ] 未破坏既有功能路径：产品切换（局部刷新）、时间切换（重建）、多屏布局增减、点击取值
- [ ] 遵守第 6 节硬性约束
- [ ] 公共 API 有中文 JSDoc；CLAUDE.md 追加本轮变更日志（固定四分区，倒序追加，勿删历史）
