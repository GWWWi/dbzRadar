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
| 框架 | Vue 3.4（`<script setup lang="ts">`）+ Vite 5 + TS 5.4 |
| 地图 | QuickEarth 3.2.2（`@quickearth/core` + `@quickearth/leaflet`）+ Leaflet 1.9.4 |
| QE 地图类 | `LMap extends Leaflet L.Map`——Leaflet 的 on/popup/layer API 全部可用 |
| QE 初始化 | `src/main.ts`：先设 `consts.wasmPath='/libs/wasm'`、`workerPath='/libs/workers'`，再 `qeInit(undefined, true)` 免费二维模式 |
| dev | `npm run dev`（scripts/dev.cjs，端口 5173，strictPort） |
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
  main.ts                      QE init + 挂载 Vue
  App.vue                      布局编排 + 启动拉取 products/config/files + 播放定时器(800ms)
  styles.css                   全局深色主题样式
  types/index.ts               ★ 数据契约（唯一类型源）：ColorStop/RadarProduct/RadarProductType/RadarFileMeta/RadarGrid/AppConfig/TimelineConfig
  config/products.ts           内置产品静态目录 PRODUCTS（服务器产品目录的回退）+ 色标函数 reflectivityColorStops()
  api/productApi.ts            fetchProductList()（服务器 products.json → 失败回退静态）/findProduct(id)/setProductUrl(url)
  api/configApi.ts             fetchAppConfig()（config.json，缺失回退清单模式）/setConfigUrl(url)/buildTimelineTimes(cfg, anchorMs?) 时间轴生成
  api/radarApi.ts              fetchRadarFileList(url?)/buildFileMetaFromTemplate(template,time)/RadarFileMissingError(404)/fetchRadarGrid(meta, productId) 分派解析器
  parse/mosaicParser.ts        SWAN 拼图 "diamond" 头：isRADAMOSAIC()/parseRADAMOSAIC()
  parse/cinradParser.ts        CINRAD 单站 RSTM："RSTM" 魔数：parseRSTM()（失败时 buildSynthetic 兜底，永不抛错）
  parse/micapsM4Parser.ts      MICAPS 第4类文本：isMicapsM4()/parseMicapsM4()
  render/mapManager.ts         createRadarMap(el)/addTiandituBase(map)（天地图 vec_w+cva_w）/setMapLink/registerMapLink/unregisterMapLink（多屏地图联动：缩放+平移视野同步，syncing 标记防 move 事件死循环）
  render/radarRenderer.ts      ★ 核心：renderRadar(smooth)/updateRadarProduct(smooth)/updateRadarSmooth/removeRadar/sampleGridValue/firstVisibleThreshold
  store/appStore.ts            Vue reactive 单例全局状态 + mutations（setLayout/setScreenProduct/setScreenSmooth/setScreenTime/setFiles/setProducts/setPlaying/setSyncPlay/setSyncMap/setActiveScreen/setScreenStatus/setTimeline(times,template)/setTimelineConfig/getProductByIdSafe）+ 状态 timeline/fileUrlTemplate/timelineConfig + computed（activeScreen/timelineTimes：优先配置生成，回退 files 推导）；ScreenState.smooth 为每屏独立平滑开关
  components/
    Toolbar.vue                布局切换(1/2/4/6屏)/同步开关/地图联动开关/播放按钮
    ProductList.vue            左侧产品列表（作用于激活屏）
    TimeAxis.vue               Canvas 刻度轴（样式参考 timeline-canvas）：拖拽平移/点击跳转/滚轮缩放，吸附最近时次；顶条绿色刻度=有文件时次；受控组件 emit('change')
    Timeline.vue               底部时间轴（syncPlay 时广播全部屏；TimeAxis 刻度轴 + 上一/下一时次；配置模式含时间选择控件：预报选起报时间/实况选结束时间，改选后重生成时间轴；时间选择框下拉跳转时次：显示 YYYY-MM-DD HH:mm，值 YYYYMMDDHHmm）
    RadarScreen.vue            ★ 单屏容器：建图/watch 取数渲染/点击取值 popup/无文件提示“该时次无文件”/屏头平滑开关（每屏独立）/卸载销毁
    Legend.vue                 右下角色标浮层（可拖拽，pointer-events 不拦截地图）
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
renderRadar 会把低于 `firstVisibleThreshold(product)`（首个 alpha>0 档的 value）的值
**就地**置为 undef。持有同一 grid 引用的地方（如 RadarScreen.layerGrid）取值结果与显示一致。

## 5. 关键调用链

```
启动:   App.onMounted → Promise.all([fetchProductList(), fetchAppConfig()])
        → setProducts + setTimelineConfig
        → config 存在: setTimeline(buildTimelineTimes(cfg)) 生成时间轴
          （有 fileUrlTemplate → 模板模式；无 → 再 fetchRadarFileList(cfg.fileListUrl)）
        → config 缺失: setFiles(fetchRadarFileList()) 清单回退模式（时间轴=清单时刻）

单屏:   RadarScreen.onMounted → createRadarMap + addTiandituBase + registerMapLink + map.on('click')
        watch(productId|time|smooth) → refresh():
          文件解析: 模板模式 buildFileMetaFromTemplate(tpl, time)；
                    清单模式 files.find(time)，找不到 → 状态提示“该时次无文件”
          仅产品变(时间同) → updateRadarProduct(layer, grid, oldThreshold, product, smooth)
          仅平滑变(时间同) → updateRadarSmooth(layer, product, smooth)（bitmap↔pixel1 局部刷新）
          否则 → fetchRadarGrid(file, pid)（404 → RadarFileMissingError → “该时次无文件”）
                → removeRadar(旧) → renderRadar(map, grid, product, smooth)

点击:   map click → sampleGridValue(layerGrid, lat, lng)
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
3. **renderRadar 就地修改 grid.data**（弱值置缺测）。需保留原始数据请先拷贝。
4. **QE 资源路径必须在 qeInit 前设置**（main.ts 已处理，勿动顺序）。
5. **缺测哨兵统一 999999**（SYNTH_UNDEF/UNDEF），新解析器必须遵守。
6. **多屏地图容器 id 必须唯一**：`'radar-map-' + screenId`。
7. **非响应式对象不进 reactive**：map/layer/grid 用普通变量保存（见 RadarScreen）。
8. **时间轴升序依赖** manifest.json 排序，radarApi 内已再 sort 双保险。
9. yDelta 可正可负，任何行号换算禁止假设"第 0 行在南"。
10. **时间轴与文件解耦**：配置模式时间轴按规则生成，时次未必有文件——
    清单模式找不到或模板模式 404 都必须提示"该时次无文件"，不得静默失败。

## 7. 分层规则与编码规范

- 依赖方向单向：`components → api/render → parse → types`；store 可被 components/api 之上所有层引用。
  禁止反向依赖（parse 不得 import api/render/components）。
- 注释：中文 JSDoc 风格，说明"为什么"；每个文件头部有一段职责总述。新增公共导出必须带注释。
- 命名：文件 kebab-case（ts）/PascalCase（Vue 组件）；CSS 类沿用 styles.css 现有 BEM-ish 风格。
- 类型集中放 types/index.ts，不在业务文件里重复定义领域模型。
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
