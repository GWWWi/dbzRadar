# AGENTS.md —— AI 开发上下文文档

> 本文档供各类 AI 编码助手（Claude/Codex/Cursor/opencode 等）快速建立项目认知。
> 内容为事实性速查，修改代码前请通读第 6 节"硬性约束"，完成后按第 9 节 DoD 验证。

## 1. 项目一句话

二维雷达显示平台：把多种雷达数据格式解析为统一经纬度网格 RadarGrid，
用 QuickEarth(Leaflet) 以**不平滑的 bitmap 格点填色**渲染成分级色斑图，
支持产品列表 / 时间轴动画 / 多屏对比 / 点击取值。

## 2. 技术栈与命令

| 项 | 值 |
| --- | --- |
| 框架 | Vue 3.4（`<script setup lang="ts">`）+ Vite 5 + TS 5.4 + Element Plus（时间选择控件与 ElMessage 提示，html.dark 深色主题） |
| 地图 | QuickEarth 3.2.2（`@quickearth/core` + `@quickearth/leaflet`）+ Leaflet 1.9.4 |
| QE 地图类 | `LMap extends Leaflet L.Map`——Leaflet 的 on/popup/layer API 全部可用 |
| QE 初始化 | `src/main.ts`：先设 `consts.wasmPath='/libs/wasm'`、`workerPath='/libs/workers'`，再 `qeInit(undefined, true)` 免费二维模式 |
| dev | `npm run dev`（scripts/dev.cjs，端口 5179，strictPort，`host: true` 监听所有网卡 → 可经本机 IP 局域网访问），mode=development → 读 `.env.development`；`/radar-data` 代理到 `http://localhost:9099/data/radarData` |
| build | `npm run build`（scripts/build.cjs），mode=production → 读 `.env.production`；`vite.config.ts` 的 manualChunks 将 vue / element-plus / quickearth 拆为独立 vendor chunk |
| 环境变量 | `.env.development` / `.env.production`（仓库提交）+ `.env.example`（模板）；变量 `VITE_DATA_BASE_URL` / `VITE_TILE_SERVICE_BASE` / `VITE_TIANDITU_KEY`，类型见 `src/types/env.d.ts`；**构建时内联**，改完必须重新 dev/build，不能只改服务器上的文件 |
| 类型检查 | `npx vue-tsc --noEmit -p tsconfig.json` |
| 单元测试 | `npm test`（Vitest 1.6；覆盖 datetime/coords/range/messages/configApi/appStore、radarCache/radarApi 取数并发、radarFormat 分派/productApi 目录、rstmRadials/rstmPolar/rstmGrid/valueQuery） |
| 部署 | `docs/DEPLOY_GUIDE.md`（现场实测值/目录与端口清单/nginx 说明/发布与验收步骤/待决项） |
| 用户手册 | `docs/USER_GUIDE.md`（面向值班/业务使用者：界面、状态文案含义、读图口径、FAQ） |

## 3. 目录地图

```
index.html                     单页入口 #app
.env.development               dev 环境值：/radar-data/（走 Vite 代理）+ 公网天地图
.env.production                生产环境值：/data/radarData/（nginx 前缀）+ 内网 WMTS 地址与 tk
.env.example                   变量模板（清单/含义/读取位置）；现场覆盖用 .env.*.local（已 gitignore）
docs/DEPLOY_GUIDE.md            ★ 部署运行手册（基于现网实测，改环境/改 nginx 前先查它）
docs/USER_GUIDE.md              ★ 用户使用手册（面向操作人员，写 UI 行为与读图口径）
vite.config.ts                 public/ 原样拷贝 + build.manualChunks（vue/element-plus/quickearth vendor 分包）+ 注入 __APP_VERSION__ 并产出 dist/version.json（供前端轮询自动刷新）
scripts/
  dev.cjs / build.cjs          启动/构建脚本（Node >=18）
  prepare-data.cjs             npm run prepare:data：bz2→bin 预解压 + 生成 manifest.json
public/data/
  manifest.json                文件清单：file/binFile/time/stationId/stationName/hasData/format（可选 compressed）
  products.json                服务器产品目录（可删除 → 回退内置静态目录）
  config.example.json          应用配置示例（部署时复制为 config.json 放服务器任意目录；dataSourceMode: both/latest/upload）
src/
  main.ts                      QE init + 挂载 Vue（含 Element Plus 样式与深色主题 css-vars，html.dark 已在 index.html 声明）
  App.vue                      布局编排 + 启动拉取 products/config（dataSourceMode 分流：清单/最新时间）；播放编排在 usePlayback
  styles.css                   全局深色主题样式
  constants.ts                 ★ 跨层常量：统一缺测哨兵 UNDEF
  mapBorder/                   ★ 国界底图数据：worldGJ(179 国) / chinaGJ(全国) / chinaSJ(42 省)，合计约 4MB
  utils/datetime.ts            ★ 时间格式转换唯一实现：msToISO/msToText/formatShortTime/isoToMs/isoToCompact/compact12ToISO/digits14ToISO/pad2
  utils/coords.ts              ★ 经纬度展示格式化：formatLat/formatLon/formatLatLon（负值 → S/W；禁止组件里手拼 °N/°E）
  utils/http.ts                ★ fetchWithTimeout（默认 10s）+ FetchTimeoutError：所有网络请求统一走这里
  utils/range.ts               ★ 色标范围：isValueInRange/isValueVisible/valueRangeKey/rangeFromStopIndex/stopIndexFromRange（渲染、取值、图例共用同一口径）
  utils/gridSample.ts          ★ 网格单点取值（纯函数）：sampleGridRaw（只判边界/缺测）/sampleGridValue（可见性口径）；radarRenderer 与 valueQuery 共用，避免两套口径漂移
  utils/bzip2.ts               ★ bzip2 解压（seek-bzip + buffer polyfill）：.bz2 雷达基数据在浏览器端解压
  utils/versionCheck.ts        生产版本检测：轮询 version.json（5 分钟 + 切回前台），发现新版本自动刷新（同一版本只自动刷一次，防死循环）
  types/index.ts               ★ 数据契约（唯一类型源）：ColorStop/RadarProduct/RadarProductType/RadarFileMeta/RadarGrid/RadarQueryResult/AppConfig/TimelineConfig/DataSourceMode/BaseMapMode/ValueRange/RstmVolume/RstmRadial
  types/env.d.ts               ImportMetaEnv 补充声明（VITE_ 变量全部可选，缺省走读取处兜底）
  config/products.ts           内置产品静态目录 PRODUCTS（服务器产品目录的回退）+ 8 个产品的专用色标函数；产品 id 与 RSTM 字段名一致（dBZ/dBT/V/W/ZDR/CC/KDP/SNRH）
  config/dataSource.ts         ★ 雷达数据基地址 DATA_BASE_URL = VITE_DATA_BASE_URL（缺省 /radar-data/，dev 由 Vite 代理到 9099），含尾斜杠兜底
  api/productApi.ts            ★ 产品目录唯一事实源：fetchProductList()/catalogProducts（响应式 computed，服务器目录→静态兜底）/findProduct/setProductUrl/setLoadedProducts；store.products 直接派生自它，不另存副本
  api/configApi.ts             fetchAppConfig()（config.json 含 dataSourceMode: both/latest/upload，缺失回退清单模式）/setConfigUrl(url)/buildTimelineTimes(cfg, anchorMs?) 时间轴生成/fetchLatestTime（★ 假实现：返回当前时间，接真实后端时替换）/snapNearestTime
  api/radarApi.ts              对外门面：fetchRadarGrid/fetchRstmVolume 的缓存编排 + 兼容导出（原有 import 路径不变）
  api/radarCache.ts            ★ LruCache（条数/字节双上限）+ SharedTask（引用计数取消，waiters 归零才 abort）
  api/radarManifest.ts         清单发现（配置 → manifest → 目录扫描 → 本地回退）/buildFileMetaFromTemplate/resolveDataUrl
  api/radarSource.ts           下载 + bz2 解压（Worker）+ loadGrid/loadVolume/parseUploadedFile（解析委托 radarFormat + decodeClient）+ 失败 buffer 复用
  api/radarFormat.ts           ★ 格式识别与解析分派唯一入口（取数/上传共用）：detectRadarFormat（魔数优先）/parseRadarBuffer（RSTM 优先体→合成兜底）/reconcileMosaicTime；新增格式只改这里
  api/decodeWorker.ts          ★ 解码 Worker（无状态纯计算）：decompress/parseGrid/parseVolume/parseAny/layerToGrid 五类操作；响应 buffer 用 transfer 零拷贝回传
  api/decodeClient.ts          ★ Worker 主线程客户端：懒创建单例 + id↔Promise + signal 只取消等待；Worker 不可用/故障自动回退主线程同一套纯函数（runDecode/terminateDecodeWorker）
  api/localFiles.ts            本地文件夹文件源：分组追加/删除、时次索引（getLocalFile 供 refresh 优先命中）；结构记忆 localStorage + 目录句柄 IndexedDB（跨会话自动恢复）
  api/localFileStore.ts        IndexedDB 目录句柄读写封装（File System Access API 的句柄持久化）
  parse/mosaicParser.ts        SWAN 拼图 "diamond" 头：isRADAMOSAIC()/parseRADAMOSAIC()
  parse/cinradParser.ts        CINRAD 单站 RSTM 单层合成兜底：parseRSTM()/buildSynthetic()（isSynthetic 恒 true，头部只提供站点定位；仅在标准体解析失败后使用，真实体解码在 rstmRadials.parseRstmVolume）；导出 tryParseHeader 供 rstmRadials 复用
  parse/cinradVolume.ts        RSTM 对外门面：re-export parseRstmVolume/sampleRstmValue/latLonToPolar/volumeToGrid 等（原有 import 路径不变）
  parse/rstmRadials.ts         二进制头/cut/径向/矩解析（一个 DataView、8 位矩用 Uint8Array、字段反向表、空字段共享）
  parse/rstmPolar.ts           经纬度↔极坐标、地面↔斜距、最近邻/九点取样、findNearestRadialIndex
  parse/rstmGrid.ts            极坐标→0.01° 网格：layerToGrid 纯计算（可进 Worker）+ volumeToGrid 同步门面 + per-volume 小 LRU（6 条，键=层|字段）+ peekVolumeGrid/buildGridLayerPayload（单层载荷）；地面→斜距 LUT（groundToSlantFast）
  parse/valueQuery.ts          ★ 单点取值纯函数：fieldForProduct（产品→字段）/rawValueAt（原始值）/queryValue（原始值 + 九点均值 + 可见性与原因），UI 只负责弹窗
  parse/rstmRadials.test.ts    ★ 二进制解析回归测试：手工构造最小 RSTM 缓冲，覆盖校验/解码/16 位/dealias/长短圈合并/时间
  parse/micapsM4Parser.ts      MICAPS 第4类文本：isMicapsM4()/parseMicapsM4()
  render/mapManager.ts         地图能力门面：re-export createRadarMap/applyBaseMap 等；applyBaseMapToAll 与 unregisterMapLink（联动 + 底图清理）
  render/mapFactory.ts         createRadarMap（QE LMap + 版权条清理）
  render/baseMap.ts            天地图/国界底图（admin/border，地址由 TILE_SERVICE_BASE 决定；border 配色陆地 #efefdb、海洋 #97b6e1、界线 #606266）、边界数据缓存、切换 token、cleanupBaseMap
  render/mapLink.ts            多屏联动（move 经 rAF 合并）；只管理连接表，不碰底图
  render/radarRenderer.ts      ★ 核心：renderRadar(smooth,range)/updateRadarProduct/updateRadarSmooth/updateRadarRange/removeRadar/sampleGridValue/firstVisibleThreshold；数据源按 grid+阈值+范围共享（每 grid 小 LRU 3 条，多屏同口径复用同一 provider）
  store/appStore.ts            Vue reactive 单例全局状态 + mutations（setLayout/setScreenProduct/setScreenSmooth/setScreenRange/setScreenElevations/setScreenElevation/setScreenTime/setFiles/setProducts(委托 productApi)/setPlaying/setSyncPlay/setSyncMap/setBaseMap/setActiveScreen/setScreenStatus(text,kind)/setScreenSynthetic/setScreenLoading/setDataSourceMode/setLocalFileTimes/setTimeline(times,template)/setTimelineConfig/getProductByIdSafe）+ 状态 timeline/fileUrlTemplate/timelineConfig/dataSourceMode/localFileTimes + computed（activeScreen/timelineTimes/products=productApi.catalogProducts）；ScreenState.smooth / valueRange / elevations+elevationIndex / synthetic 每屏独立，statusKind 为状态语气（配色/播报），loading 为播放避让的忙标记
  constants/messages.ts        ★ 用户可见提示文案唯一来源：STATUS（屏头状态）/ UPLOAD_MSG / VERSION_MSG / TIMELINE_MSG / APP_MSG / FOLDER_MSG / QUERY_LABEL + noDataText/uploadDataLabel/querySourceOf（坐标查询的“来源与口径”说明）；与 docs/USER_GUIDE.md §6 状态表逐条对应
  composables/useRadarScreen.ts ★ 单屏地图/取数/图层状态机：建图销毁、watch 刷新、局部更新、取值（调用 parse/valueQuery）、上传；图层判重字段集中在 LayerState（commitLayer 统一写入/resetLayer 统一清空）；栅格化走 fetchVolumeGrid（Worker）
  composables/usePlayback.ts   播放编排：800ms 定时器（loading 避让）+ 下一时次预取（下载+解析+栅格化进缓存，停止播放时 abort）
  composables/uploadRouter.ts  跨组件上传路由：屏 id → onUpload 处理器表（各屏挂载时注册/卸载时注销，侧栏把文件交给激活屏）
  components/
    Toolbar.vue                布局切换(1/2/4/6屏)/同步开关/地图联动开关/播放按钮
    ProductList.vue            左侧产品列表（作用于激活屏）
    FolderFiles.vue            左侧「文件夹文件」：选目录累加多组/整组删除；句柄授权记忆（http 环境降级 webkitdirectory）；点击文件经 uploadRouter 交激活屏渲染
    TimeAxis.vue               Canvas 刻度轴（样式参考 timeline-canvas）：拖拽左右任意平移（不触发取数），松手后吸附最近时次并 emit('change') 加载对应文件；点击跳转/滚轮缩放；顶条绿色刻度=有文件时次；受控组件；重绘经 rAF 合并，marks 升序二分只画可见区间
    Timeline.vue               底部时间轴（syncPlay 时广播全部屏；TimeAxis 刻度轴 + 上一/下一时次；Element Plus 控件：el-date-picker 选锚点（配置模式，预报起报/实况结束，改选重生成时间轴）+ el-date-picker 跳转时次（显示 YYYY-MM-DD HH:mm，值 YYYYMMDDHHmm，**不做吸附**：按分钟精确定位，清单时刻带秒时可能匹配不上 →“该时次无数据”））
    RadarScreen.vue            ★ 单屏容器（薄壳）：组合 useRadarScreen + ScreenHeader + CoordinateQuery + Legend
    ScreenHeader.vue           屏头：序号/产品/时间/状态、仰角选择（仅 RSTM 基数据体）、平滑开关、上传入口（emit File）
    CoordinateQuery.vue        坐标查询面板：输入校验 + 展示取样结果（sample 回调由父组件注入，不持有地图/图层）
    Legend.vue                 右下角色标浮层（可拖拽；每屏独立的色标范围：自绘双圆点手柄叠加在色标条上，只显示所选区间颜色，范围外透明）
```

## 4. 核心数据契约（src/types/index.ts）

### RadarGrid（解析输出 = 渲染输入）
- `x`=经度、`y`=纬度（度）；`xStart/xDelta/xSize`、`yStart/yDelta/ySize`
- `data: Float32Array` 行优先一维数组，长度 xSize*ySize，索引 `row*xSize+col`
  （比 number[] 省一半堆内存，与 QE GridDataType.Float32 内存布局一致）
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

### 解码 Worker 契约（types/index.ts）
- `DecodeOp`：decompress / parseGrid / parseVolume / parseAny / layerToGrid 五操作；
  请求/响应经 `DecodeRequest/DecodeResponse`（id 对应），结果 buffer 用 transfer 零拷贝回传。
- `GridLayerPayload`：栅格化只传**单仰角层** + 最小体元数据（数组按层切片为单元素，
  Worker 侧 layerIdx=0），不传整个 volume（上百 MB 的克隆会吃掉 Worker 化收益）。
- `RadarParsedData`：取数与上传共用的解析结果（volume | grid）。
- ★ Worker 无状态 ★ 缓存在主线程（radarApi LRU / rstmGrid per-volume LRU），
  Worker 只做纯计算；产品元信息由主线程查好传入（Worker 内没有服务器产品目录）。

## 5. 关键调用链

```
启动:   App.onMounted → Promise.all([fetchProductList(), fetchAppConfig()])
        → setProducts + setDataSourceMode(config.dataSourceMode ?? 'both')
        → config 存在: setTimelineConfig + setTimeline(buildTimelineTimes(cfg), fileUrlTemplate)
          （both 且无 fileUrlTemplate → fetchRadarFileList(cfg.fileListUrl)；
            latest 缺 fileUrlTemplate → ElMessage 警告；upload 不取服务器数据）
        → config 缺失: setFiles(fetchRadarFileList()) 清单回退模式（时间轴=清单时刻）
        → 非 upload 模式: fetchLatestTime（当前为假实现）→ snapNearestTime 吸附时间轴
          → setScreenTime 跳到最新时次
        另：FolderFiles.onMounted → restoreLocalFolders() 恢复上次文件夹（句柄已授权则自动枚举）

单屏:   RadarScreen → useRadarScreen.onMounted → createRadarMap + applyBaseMap + registerMapLink
        + map.on('click') + registerUploadHandler + ResizeObserver(invalidateSize + reinit)
        watch(productId|time|smooth|range|elevation) → refresh()（refreshToken 判重 + inflight abort）:
          时间未变 → 局部更新（必须先于文件匹配，上传数据不在清单里）：
            体数据且仰角/字段变 → fetchVolumeGrid（Worker 栅格化，LRU 命中直返）+ 重建图层（不重新下载）
            仅产品变 → updateRadarProduct；仅范围变 → updateRadarRange；仅平滑变 → updateRadarSmooth
          本地文件夹文件命中 getLocalFile(time) → parseUploadedFile 直接解析（不请求服务器）
          upload 模式 → 清屏 + “仅上传模式”提示
          文件解析: 模板模式 buildFileMetaFromTemplate(tpl, time)；
                    清单模式 files.find(time)，找不到 → 状态提示“该时次无数据（最近可用 …）”
          否则 → rstm 格式先 fetchRstmVolume（体数据，失败回退），其余 fetchRadarGrid
                （下载 → Worker 解压 → Worker 解析；404 → RadarFileMissingError → “该时次无数据”）
                → removeRadar(旧) → renderRadar(map, grid, product, smooth, range)
                → fitToGrid(grid)：数据范围变化时自动定位（同区域切时次不重置视野）
        图层写入统一走 commitLayer（判重字段一次性同步），清空统一走 resetLayer

点击:   map click / 坐标查询面板 → queryValue({grid, volume, 仰角, threshold, range})（parse/valueQuery）
        → 原始值 + 9 点均值 + 可见性原因 + querySourceOf 来源标签
        → 有可见值: L.popup('.value-popup') 显示数值/均值/来源 + 经纬度(formatLatLon)
        → null: map.closePopup()（面板仍展示原始值与原因，不弹 ElMessage）

上传:   屏头上传 / FolderFiles 点击 → (uploadRouter) → onUpload → parseUploadedFile
        → volume（保留仰角维度）或 grid → applyParsedData 记为本屏当前时次（切时次后恢复时间轴数据）

选锚点: Timeline 时间选择控件（配置模式）→ buildTimelineTimes(cfg, anchor) 重生成
        → setTimeline + setScreenTime 跳到锚点时次（syncPlay 广播全屏）

播放:   usePlayback setInterval 800ms → 任一相关屏 loading 则不推进（播放避让）
        → setScreenTime(激活屏, 下一时次)（syncPlay 广播全屏，到尾循环）
        → 预取下一时次（fetchRstmVolume/fetchRadarGrid + fetchVolumeGrid 进缓存，
          与 refresh 同键自动合并；停止播放时 abort，失败静默）
```

## 6. 硬性约束与踩坑（违反必出 bug）

1. **色标首档必须透明兜底**：`{ value:-100, stop:[0,0,0,0] }`（速度产品用 -1000）。
   QE bitmap 模式把低于首阈值的值钳位到第一档颜色，无透明兜底档会出现整幅"蓝色底色"。
2. **compressjs 只能在 Node 用**：浏览器引入会因 amdefine 白屏崩溃（仅 scripts/prepare-data.cjs 使用）。
   bz2 可由 prepare-data 预解压成 .bin，也可直接分发 .bz2 由前端 utils/bzip2.ts（seek-bzip）浏览器端解压（见第 18 条）。
3. **渲染层禁止修改 grid.data**：`renderRadar` 在副本上过滤弱值。就地修改会让低阈值产品
   的弱值在切回时永久丢失（切产品 → 数据静默损坏）。
4. **QE 资源路径必须在 qeInit 前设置**（main.ts 已处理，勿动顺序）。
5. **缺测哨兵统一 999999**（SYNTH_UNDEF/UNDEF），新解析器必须遵守。
6. **多屏地图容器 id 必须唯一**：`'radar-map-' + screenId`。
7. **非响应式对象不进 reactive**：map/layer/grid 用普通变量保存（见 useRadarScreen）。
8. **时间轴升序依赖** manifest.json 排序，radarManifest 内已再 sort 双保险。
9. yDelta 可正可负，任何行号换算禁止假设"第 0 行在南"。
10. **时间轴与文件解耦**：配置模式时间轴按规则生成，时次未必有文件——
    清单模式找不到或模板模式 404 都必须提示"该时次无数据"，不得静默失败。
11. **fetchRadarGrid / fetchVolumeGrid 返回的是共享缓存对象**：多屏/播放复用同一引用，
    任何调用方不得修改 `grid.data` / `undef` / `time`（渲染层在副本上过滤弱值，取值只读）。
12. **时间轴时次上限 3000**：超限时 buildTimelineTimes 自动按整分钟放大间隔并 warn；
    默认 6 分钟 × 10 天 = 2401 档，该保护不得改变默认配置的行为。
13. **网络请求统一走 `utils/http.ts` 的 fetchWithTimeout**：原生 fetch 没有超时，
    网络半开会让屏永久停在“加载中…”并卡住播放；播放避让读 `ScreenState.loading`
    （禁止比较 status 文案），AbortError 必须清 loading 且保留旧画面。
14. **输入边界**：上传文件 ≤200MB；产品色标必须严格升序、RGBA 各分量 0~255、
    至少一个 alpha>0 档（首档不透明只告警不拒绝）。
    单幅网格点数**不设上限**（曾有 400 万点限制，已按需求取消）；超大网格仅由
    “数据区不足 / 数据 token 不足”的原有校验兜底。
    （rstmGrid 的 MAX_GRID_POINTS=200 万是 RSTM 栅格化**输出分辨率**的防御钳制，
    不是输入校验上限，两者不是一回事）。
15. **色标范围语义 [min, max)**：范围外格点渲染为透明、取值返回 null；上界为开区间，
    图例选“20~50 档”对应 max=55（结束档的下一档值）。索引↔数值换算只在 `utils/range.ts`，
    渲染层与图例不得各写一份。
16. **QE 图层更新后必须强制重绘**：`setDataSource` / `setDrawOptions` 只替换数据与样式，
    不会主动绘制（GL 图层没有持续渲染循环）。`renderRadar` 之后的所有局部更新
    （`updateRadarProduct` / `updateRadarRange` / `updateRadarSmooth`）末尾都要 `forceRedraw(layer)`
    （内部调 QE 公开 API `reinit()`）。否则表现为“数据已变、画面要等缩放/拖动地图才刷新”。
    新建图层的 `renderRadar` 不需要调用（`addLayer` 会触发绘制）。
17. **底图双模式**：`border`=矢量（**默认**；容器背景海洋色 + 世界/中国陆地填充 + 省界线）；`admin`=天地图瓦片。
    矢量底图必须放在 `qe-base-border` pane（zIndex 190），否则会盖住雷达色斑图。
    边界数据用 `?url` 按需加载（约 4MB），**禁止改成静态 import** 打进主包；
    每张地图的切换有独立 token，异步加载回来时若已切走/卸载必须丢弃结果。
18. **雷达数据源**：默认基地址 `/radar-data/`（`src/config/dataSource.ts`），由 Vite 代理到
    `http://localhost:9099/data/radarData/`（该静态服务未返回 CORS 头，前端不能直接 fetch 绝对地址）。
    清单获取顺序：配置地址 → 数据服务 `manifest.json` → 目录索引扫描 → 本地 `data/manifest.json`；
    目录扫描纳入 `.m4` / `.bin` / `.bin.bz2`：`.bz2` 由 `utils/bzip2.ts`（seek-bzip + Buffer polyfill）
    在浏览器端解压，解压后按二进制魔数（RSTM / SWAN / diamond 4）识别格式，不依赖文件名。
    compressjs 仅 Node 可用（浏览器触发 amdefine 报错），前端解压禁止使用它。
19. **共享在途请求必须用引用计数取消**：`fetchRadarGrid`/`fetchRstmVolume` 的
    AbortSignal 只取消调用方自己的等待，waiters 归零时才 abort 底层请求；
    禁止把第一个调用方的 signal 直接传给共享 fetch（会连累其它屏停在“加载中…”）。
20. **环境地址只能走 `.env`，不得写回源码**：`VITE_DATA_BASE_URL`（数据前缀）/
    `VITE_TILE_SERVICE_BASE` + `VITE_TIANDITU_KEY`（底图瓦片，必须成对）。
    生产的数据前缀**必须与 nginx 的数据 location 前缀逐字一致且末尾带 /**（现网
    `/data/radarData/` ↔ `location /data { alias E:/ngi/met; }`）；对不上时请求会落到 SPA
    的 `try_files … /index.html` 回落，返回 **200 的 HTML** 而不是 404 —— 前端把 HTML
    当二进制解→合成兜底→屏头显示“示意数据”假回波，错得静默、极难发现。
    另：`/data` 前缀被 nginx 接管后，`dist/data/`（示例 config/products/manifest）在站点上
    就访问不到了，这些文件要么放数据目录，要么用绝对路径重新映射。
21. **volumeToGrid 结果只读且按 volume 小 LRU 缓存（6 条，键=层索引|字段）**：多屏共享同一
    `RadarGrid`，禁止修改 `grid.data`/`time`；多屏不同仰角/字段不再互相挤掉（旧单条缓存会抖动）。
    异步业务入口是 `radarApi.fetchVolumeGrid`（LRU 命中直返，miss 交 Worker 栅格化）；
    `volumeToGrid` 同步门面仅供兜底/测试；`layerToGrid` 是无缓存纯函数（Worker 用）。
22. **RSTM 栅格化的地面→斜距换算走 LUT**：`rstmGrid.groundToSlantFast` 按仰角（0.01° 取整）
    缓存 100m 步长查找表；与 `groundToSlantRange` 误差 <1m（rstmGrid.test 保证）。
    修改步长/最大距离必须同步更新测试，否则会产生“图上颜色与点击取值错库”。
23. **CPU 密集操作必须走解码 Worker**：bz2 解压 / 二进制解析 / 栅格化经 `decodeClient.runDecode`
    在 Worker 执行，主线程只 await + token 判重；禁止在业务代码重新引入同步解压/解析。
    Worker 不可用/故障时 decodeClient 自动回退主线程同一套纯函数（功能不缺失）；
    请求 payload 不 transfer（保留兜底重试能力），响应结果 buffer 用 transfer 零拷贝。
    测试环境（Node）自动走兜底路径，无需 mock Worker。
24. **产品目录单一事实源**：`productApi.catalogProducts`（响应式）是全平台唯一目录状态；
    store.products 直接派生、setProducts 委托写入，禁止在 store/组件另存目录副本
    （两套兜底链会漂移：setProductUrl 清缓存后旧副本仍在）。
25. **格式识别与分派只在 radarFormat**：取数（loadGrid）与上传（parseUploadedFile）共用
    detectRadarFormat/parseRadarBuffer；新增格式只改这一处，禁止再写第二套魔数判定顺序。
26. **图层判重字段集中在 LayerState**：useRadarScreen 的图层快照（grid/time/productId/
    threshold/smooth/range/format/compressed/volume/elevation）写入统一走 commitLayer、
    清空统一走 resetLayer；新增判重字段只改这两个函数，禁止再散落闭包变量手工同步。

## 7. 分层规则与编码规范

- 依赖方向单向：`components → composables → api/render → parse → types`；composables 可引用 store，
  store 可被 components/api 之上所有层引用。禁止反向依赖（parse 不得 import api/render/components）。
- 注释：中文 JSDoc 风格，说明"为什么"；每个文件头部有一段职责总述。新增公共导出必须带注释。
- 命名：文件 kebab-case（ts）/PascalCase（Vue 组件）；CSS 类沿用 styles.css 现有 BEM-ish 风格。
- 类型集中放 types/index.ts，不在业务文件里重复定义领域模型。
- 时间格式转换统一走 `src/utils/datetime.ts`（ISO / 紧凑串 / 显示文本），业务文件禁止自写格式化；
  缺测哨兵统一用 `src/constants.ts` 的 `UNDEF`，禁止解析器各写一份。
- UI 全局样式进 src/styles.css（带分节注释横线），组件内尽量少写 scoped style。
- 保持现有代码风格：不改无关格式、不顺手重构。
- 单元测试与被测模块同目录（`*.test.ts`），用 Vitest；只测纯逻辑，禁止 import QE/地图模块。

## 8. 常见任务配方

### A. 新增产品（仅配色/单位不同）
在 src/config/products.ts 的 PRODUCTS 追加一项即可（含透明兜底档，标注 type 实况 obs/预报 fcst）。无需动其他层。

### B. 新增需要专门解析的产品
1. src/parse/ 新增解析器 → 输出 RadarGrid（undef=999999，永不抛错可用 buildSynthetic 兜底）
2. **radarFormat.parseRadarBuffer 加分派**（取数与上传共用这一处，不再有两套判定顺序）；
   Worker 与主线程兜底自动共用新分派，无需另改
3. 新文件类型：扩展 RadarFileFormat 类型 + manifest.json + detectRadarFormat()/guessFormat()（radarFormat）+ buildMetaFromFileName()（radarManifest）

### C. 修改色标
只改 products.ts 对应产品的 colorStops（升序、RGBA 0~255、首档透明兜底）。
运行中切产品走 updateRadarProduct 局部刷新。

### D. 新增地图交互
参考 `composables/useRadarScreen.ts` 的 onMapClick：LMap 即 Leaflet Map，直接用原生事件/L.popup/L.marker。

### E. 接入真实后端
改 api 层入口即可，上层零改动：产品目录 setProductUrl(url)、应用配置 setConfigUrl(url)
（时间轴规则 + fileUrlTemplate 文件地址模板，{time} → yyyyMMddHHmmss）、清单 fetchRadarFileList(url)；
另 configApi.fetchLatestTime 目前为假实现（返回当前时间），需替换为真实最新时间接口。

### F. 切换部署环境（dev / 生产 / 换服务器）
只改根目录 `.env.development` / `.env.production` 的值，**不动 src**：
1. `VITE_DATA_BASE_URL` → 改成目标 nginx 的数据 location 前缀（末尾带 /）；
2. `VITE_TILE_SERVICE_BASE` → 内网 WMTS 基地址（末尾不带 /），留空 = 公网 DataServer；
   同时把 `VITE_TIANDITU_KEY` 换成对应环境的 tk（两者不通用）；
3. `npm run build` 后**必须核对产物**：`Select-String -Path dist\assets\index-*.js -Pattern "<新前缀>"`；
   变量是构建时内联的，没出现就说明 .env 没被读到（文件名/mode 不对）；
4. 现场专有值写 `.env.production.local`（不入仓），构建时优先级高于 `.env.production`。

## 9. 完成定义（DoD）

- [ ] `npx vue-tsc --noEmit -p tsconfig.json` 通过
- [ ] `npm test` 通过（改到 utils/api/store 纯逻辑时必须补/改用例）
- [ ] 未破坏既有功能路径：产品切换（局部刷新）、时间切换（重建）、多屏布局增减、点击取值
- [ ] 涉外部地址的改动：确认值来自 `.env`（而不是写回源码），且 `npm run build` 后在
      `dist/assets/index-*.js` 里能 grep 到新地址
- [ ] 遵守第 6 节硬性约束
- [ ] 公共 API 有中文 JSDoc；CLAUDE.md 追加本轮变更日志（固定四分区，倒序追加，勿删历史）
