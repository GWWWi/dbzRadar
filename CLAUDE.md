# 项目基础信息

- 项目：二维雷达显示平台（radar2-2d-platform）
- 技术栈：Vite 5 + TypeScript 5.4 + Vue 3.4（script setup）+ QuickEarth 3.2.2（@quickearth/core、@quickearth/leaflet，LMap 继承自 Leaflet L.Map）+ Leaflet 1.9.4
- 目录结构：
  - `src/parse/`：解析层，把二进制/文本解析为统一网格结构 RadarGrid（mosaic / rstm / m4）；cinradVolume 为 RSTM 门面，rstmRadials（解析）/rstmPolar（取样）/rstmGrid（栅格化）为内部拆分
  - `src/api/`：接口层；radarApi 为对外门面，radarManifest（清单发现/路径）、radarSource（下载/解压/解析）、radarCache（SharedTask + LruCache）为内部拆分
  - `src/render/`：渲染层，`radarRenderer.ts` 把 RadarGrid 渲染为 LPixelLayer 色斑图（bitmap 格点填色 / pixel1 平滑，支持色标范围裁剪）；mapManager 为门面，mapFactory（建图）/baseMap（天地图/国界底图）/mapLink（多屏联动）为内部拆分
  - `src/mapBorder/`：国界底图 GeoJSON（worldGJ 179 国 / chinaGJ 全国 / chinaSJ 42 省，合计约 4MB，`?url` 按需加载）
  - `src/utils/`：datetime（时间）、http（超时 fetch）、range（色标范围换算）
  - `src/store/appStore.ts`：Vue reactive 单例全局状态（多屏 / 产品 / 时间 / 播放）
  - `src/config/products.ts`：内置产品目录（8 个产品：dBZ/dBT/V/W/ZDR/CC/KDP/SNRH，id 即 RSTM 字段名，各配专用色标）
  - `src/composables/`：useRadarScreen（单屏地图/取数/图层状态机/取样/上传）
  - `src/components/`：Toolbar / ProductList / Timeline / RadarScreen（薄壳）/ ScreenHeader / CoordinateQuery / Legend
  - `src/utils/datetime.ts`：时间格式转换唯一实现（ISO / 紧凑串 / 显示文本 / formatShortTime）
  - `src/utils/http.ts`：带超时的 fetch 封装（所有网络请求统一入口）
  - `src/utils/range.ts`：色标数值范围判断与档位↔数值换算（渲染 / 取值 / 图例共用）
  - `src/constants.ts`：跨层共享常量（统一缺测哨兵 `UNDEF`）
- 环境配置：`npm run dev`（scripts/dev.cjs，端口 5179）、`npm run build`；类型检查 `npx vue-tsc --noEmit`；单元测试 `npm test`（Vitest）
- 文档：`docs/RENDER_FLOW.md`（★ 产品渲染链路：点击产品 → 解码 → 渲染 → 值→颜色 + 排障表）/ `docs/PRODUCT_GUIDE.md`（新增产品/改色标）/ `docs/USER_GUIDE.md`（操作手册）/ `docs/DEPLOY_GUIDE.md`（部署）
- 数据契约：`src/types/index.ts` 中 RadarGrid —— x 经度/y 纬度，data 行优先一维数组，yDelta<0 表示第 0 行在最北；undef 为缺测哨兵值
- 构建：`vite.config.ts` 的 `build.manualChunks` 将 vue / element-plus / quickearth 拆为独立 vendor chunk（总字节不变，改善缓存与并行加载）。

# 迭代变更日志（按时间倒序）

【2026-11-06 本轮改动（坐标查询增加“数据来源 / 取值口径”说明：不同文件后缀结果不同）】

1. 修改文件：`src/types/index.ts`、`src/constants/messages.ts`、`src/constants/messages.test.ts`、
   `src/api/radarSource.ts`、`src/composables/useRadarScreen.ts`、`src/components/CoordinateQuery.vue`、
   `src/styles.css`、`docs/USER_GUIDE.md`、`AGENTS.md`

2. 修改目的：同一点在不同文件（`.m4` / `.bin` 拼图 / `.bin` 基数据 / `.bin.bz2`）下数值不同，
   现场会当成取值 bug 反复排查。现把“这个值是怎么取来的”随结果一起显示，并给出差异原因说明。

3. 关键规则沉淀：
   - `RadarGrid.format?: RadarFileFormat`：由取数链路按**内容识别**结果写入
     （`loadGrid` 用 `actualFormat`，因为魔数可能推翻清单/文件名的推断；`parseUploadedFile`
     返回值也带 `format`）。解析器本身不读该字段，只服务 UI 说明。
   - `RadarQueryResult.source?: RadarQuerySource{label,tip}`：由 `useRadarScreen.showValueAt`
     填充（只有 composable 能拿到 volume / 仰角 / 压缩标记），纯取值函数 `queryValue` 不关心。
     ★ 面板与地图弹窗必须显示同一 label ★（两处口径不同会被当成两种算法）。
   - `querySourceOf()`（`constants/messages.ts`）是唯一装配处，优先级：
     合成兜底 > RSTM 基数据（带当前仰角）> m4 > 拼图 > RSTM 单层 > 未知；
     `.bz2` 追加“数值与解压后完全一致”，避免把压缩包当成另一种数据源。
   - UI：面板结果多一行 `来源：…`（虚线下划线，悬停看 tip）；面板底部常驻
     `<details>不同文件结果为何不同？`（默认折叠，不占地方）；地图弹窗加一行灰字来源。
   - 文档：`USER_GUIDE` §4.5 步骤 5 + FAQ Q11 + §11 改“四条口径”，明确
     “格点产品 vs 单仰角基数据”差异与“比对需同时次 + 同仰角 + 同字段”。
   - 术语约定：m4/拼图 = **格点产品**（最近邻、约 1km 量化、无 9 点均值）；
     RSTM = **基数据**（原始径向、无量化、有仰角维度）。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` **12 文件 89 用例**全通过
   （新增 querySourceOf 5 个用例：m4 / 拼图 / 基数据带仰角 / 合成兜底优先 / .bz2 追加说明）；
   `npm run build` 成功（11.21s，`dist/assets/index-BMwNjSZ7.js` 111.61 kB，CSS 389.51 kB）。
   ⚠ 需浏览器人工确认：① 上传 m4 与 bz2 基数据后查询同一坐标，来源行分别为
   「MICAPS m4 格点（最近邻取值）」与「RSTM 基数据 x.x°（原始径向）」；
   ② 面板底部折叠说明可展开；③ 弹窗来源行不挤压数值。

【2026-11-06 本轮改动（新增渲染链路说明文档：点击产品 → 解码 → 渲染 → 值→颜色）】

1. 修改文件：`docs/RENDER_FLOW.md`（新增）、`CLAUDE.md`（项目基础信息补文档索引 + 本条日志）

2. 修改目的：把“点产品之后数据怎么解码、解码完怎么渲染、渲染怎么按值定颜色”的完整链路写成
   一份可检索文档，替代散落在源码 JSDoc 与本文件日志里的碎片说明；后续排查颜色/刷新类问题先看它。

3. 关键规则沉淀：
   - 文档结构固定：① 点击产品后的状态变化与 refresh 四分支 → ② 取数（LRU + 共享任务 + 下载/解压）
     → ③ 三种格式解码（SWAN 拼图 / MICAPS m4 / RSTM 两步：二进制→极坐标体数据、极坐标→0.01° 网格）
     → ④ `renderRadar` 五步 → ⑤ 值→颜色分档语义 → ⑥ 取值同源口径 + 排障速查表。
   - ★ 值→颜色不在 JS 里计算 ★ 平台只交给 QE 两样东西：`colorStops` 规则表 +
     `BitmapColorScaleGL` 色例纹理（`gradient=false` 分级平色），逐像素落档由 GL 查纹理完成；
     区间 `[stops[i].value, stops[i+1].value)`，缺测透明，**低于首档会被钳到首档颜色**
     —— 这就是“透明兜底档 + `buildDisplayValues` 阈值遮蔽”双保险存在的理由。
   - 数据源持有的是“按当前阈值/范围过滤后的副本”：过滤口径变化必须 `setDataSource` 重建，
     只换颜色才走 `setDrawOptions`；两者之后都要 `forceRedraw`（`reinit()`）。
   - RSTM 体数据下「仰角层 + 字段」共同决定栅格内容，切产品必须 `volumeToGrid` 重栅格化，
     不能只换色标（非体数据才可以只换色标）。
   - ★ 改链路必须同步文档 ★ 触及 `renderRadar` 签名、`radarSource` 分派、色标/范围语义时，
     同步更新 `docs/RENDER_FLOW.md` 对应章节，否则文档与代码漂移。

4. 验证方式：纯文档新增，无代码变更（未执行 `vue-tsc` / `npm test`，不受影响）；
   文中所有行号、函数名、常量、默认值已逐条回查 `ProductList.vue`、`useRadarScreen.ts`、
   `radarApi.ts`、`radarSource.ts`、`mosaicParser.ts`、`micapsM4Parser.ts`、`cinradVolume.ts`、
   `rstmGrid.ts`、`radarRenderer.ts`、`utils/range.ts`、`utils/gridSample.ts`、`parse/valueQuery.ts`。

【2026-11-05 本轮改动（提示信息优化第 3 批：去除冗余提示 + 空态/措辞/坐标统一）】

1. 修改文件：`src/utils/coords.ts`（新增）、`src/utils/coords.test.ts`（新增）、
   `src/constants/messages.ts`、`src/composables/useRadarScreen.ts`、`src/components/CoordinateQuery.vue`、
   `src/components/Timeline.vue`、`src/components/TimeAxis.vue`、`src/components/ScreenHeader.vue`、
   `src/components/FolderFiles.vue`、`src/App.vue`、`src/store/appStore.ts`、`src/render/baseMap.ts`、
   `src/styles.css`、`docs/USER_GUIDE.md`、`public/data/dataSourceMode.md`、`AGENTS.md`

2. 修改目的：清掉“同一件事说三遍”的重复提示，补齐三处空态/静默分支的说明，
   统一坐标与术语写法，并把控制台日志前缀改回与文件同名（便于按日志定位）。

3. 关键规则沉淀：
   - ★ 坐标查询不再弹 ElMessage ★ `showValueAt(lat, lon)` 去掉 `notify` 参数：
     面板已完整展示原始值 / 9 点均值 / 原因，弹窗只负责图上定位；
     原实现“弹窗 + 面板 + toast”三处重复，且 toast 里「无回波」与「低于显示阈值」混为一谈。
     地图点击保持静默（无数据只关弹窗）。
   - ★ 经纬度展示统一走 `utils/coords.ts` 的 `formatLatLon` ★
     原写法 `${lat}°N, ${lon}°E` 在负值下会输出 `-100.000°E`（方向与符号自相矛盾）；
     现按南北/东西半球取绝对值 + 后缀（`formatLat` / `formatLon` 可单独用）。
   - 空时间轴：`timelineTimes` 为空时显示橙色 `无可用时次`（title 给排查指引），
     不再显示自相矛盾的「1 / 0 时次」。
   - `dataSourceMode=latest` 缺 `fileUrlTemplate`：除 console.warn 外必须
     `ElMessage.warning`（此前界面表现为“每个时次都无数据”，现场看不出原因）。
   - `FolderFiles` 空态按 `canAutoRestore` 分支：无目录授权记忆时不再说“下次打开仍会记住”
     （与同屏环境提示矛盾）。
   - tooltip 补关键约束：上传（`.bz2` 可直接传 / ≤200MB）、刻度轴（拖拽/点击/滚轮）、
     时间跳转框（不吸附，无该分钟文件即「该时次无数据」）。
   - `ElMessage` 的 `grouping: true` 用对象形式（`ElMessage.warning({ message, grouping: true })`），
     覆盖上传与“空目录”这类可能被连点重复触发的提示。
   - 术语：「9点均值」→「9 点均值」（面板与弹窗共用 `QUERY_LABEL`，避免两处写法不一致）。
   - 控制台前缀必须与文件名一致：`[store]`→`[appStore]`、`[mapManager]`→`[baseMap]`、
     `[RadarScreen]`→`[useRadarScreen]`（按日志搜文件才能搜到）。
   - 测试：新增 `coords.test.ts`（4 组，覆盖南北纬/东西经、零值、非有限值、位数）。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` **12 文件 84 用例**全通过；
   `npm run build` 成功（9.71s，`dist/assets/index-CbqaZq7H.js` 110.20 kB，CSS 389.13 kB）。
   ⚠ 需浏览器人工确认：① 坐标查询只出现面板 + 地图弹窗、不再叠 toast；
   ② 时间轴为空时显示「无可用时次」；③ 点击地图/查询的经纬度在负值下显示 S/W。

【2026-11-05 本轮改动（提示信息优化第 2 批：文案集中 + 状态语气 + 配色/无障碍）】

1. 修改文件：`src/constants/messages.ts`（新增）、`src/constants/messages.test.ts`（新增）、
   `src/store/appStore.ts`、`src/store/appStore.test.ts`、`src/composables/useRadarScreen.ts`、
   `src/components/ScreenHeader.vue`、`src/components/FolderFiles.vue`、`src/App.vue`、
   `src/utils/versionCheck.ts`、`src/styles.css`、`docs/USER_GUIDE.md`、`AGENTS.md`

2. 修改目的：把散落在 composables / 组件里的提示字符串收口到一处；屏头状态不再只有一种橙色，
   按语气区分进行中 / 需注意 / 失败；状态变化能被读屏器播报。

3. 关键规则沉淀：
   - ★ `src/constants/messages.ts` 是“反馈类”提示文案的唯一来源 ★（STATUS / UPLOAD_MSG /
     VERSION_MSG / APP_MSG / FOLDER_MSG + `noDataText` / `uploadDataLabel`）。
     与 `src/constants.ts` 分工：后者只放影响数据正确性的数值哨兵（UNDEF），文案一律不放。
     两者并存时 `../constants` 解析到文件、`../constants/messages` 解析到目录，已验证 tsc/build 正常。
   - 新增状态文案必须同时改 `messages.ts` 与 `docs/USER_GUIDE.md` §6 状态表；
     屏头状态表是现场排查依据，脱离代码就失去意义。
   - `ScreenState.statusKind: 'info'|'busy'|'warn'|'error'` 与 `status` 由
     `setScreenStatus(id, text, kind)` 一起写入；★ 文案清空时语气一并复位 info ★
     （否则清屏后残留 error 语义）。配色：busy 蓝 `#7fb2e0` / info 灰 `#9fb4cc` /
     warn 橙 `#ffb45e` / error 红 `#ff7875`，类名 `.screen-status--<kind>`。
   - ★ 无障碍：状态区必须是**常驻容器** `.screen-status-slot` + `role="status" aria-live="polite"` ★
     aria-live 挂在 `v-if` 条件渲染的节点上时，节点插入不会被播报；只在内部切换文本。
   - `FolderFiles` 里重复出现的同一句提示已合并为 `FOLDER_MSG.noRadarFile`（原两处各写一份）。
   - 测试：新增 `messages.test.ts`（3 用例：无数据文案不出现空括号、带可用时次、来源标签）；
     `appStore.test.ts` 增加 statusKind 3 用例（同时写入 / 清空复位 / 默认 info）。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` **11 文件 79 用例**全通过；
   `npm run build` 成功（10.83s，`dist/assets/index-DC29amw8.js` 109.46 kB，CSS 389.08 kB）。
   ⚠ 需浏览器人工确认：① 状态文字颜色随语气变化（加载中=蓝、无数据=橙、失败=红）；
   ② 切时次时读屏器播报状态变化（NVDA/VoiceOver）；③ 状态区超长文本仍省略且 title 可看全。

【2026-11-05 本轮改动（提示信息优化第 1 批：修正误导/缺失提示 + 版本提示去重）】

1. 修改文件：`src/store/appStore.ts`、`src/components/ScreenHeader.vue`、`src/styles.css`、
   `src/composables/useRadarScreen.ts`、`src/api/radarSource.ts`、`src/api/radarApi.ts`、
   `src/utils/versionCheck.ts`、`docs/USER_GUIDE.md`

2. 修改目的：处理上一轮评审的 P0 项——「示意数据」在上传路径静默丢失、上传失败一律报
   「文件格式不符」、仅上传模式切时次时空白且无解释、「该时次无数据」不给可用时次、
   版本更新提示每 5 分钟重复弹。

3. 关键规则沉淀：
   - `ScreenState` 新增 `synthetic` + `setScreenSynthetic()`：★ 示意数据警示必须独立于 `status` ★
     数据来源标签（`上传数据 · 文件名`）与该警示需要同时存在，单字符串槽位必然丢一个。
     屏头渲染为红底 `.screen-synth` 标记（title 写明“禁止用于业务判断”），
     `clearLayer()` 内必须同步撤下标记，否则空屏仍挂红标。
   - 新增 `UploadFileError(reason: 'size'|'decode'|'format'|'empty')`（`api/radarSource.ts`，
     经 `radarApi` 转出）：屏头状态按原因映射为「文件过大 / 文件损坏 / 文件格式不符 / 无有效数据」，
     未知错误归「上传失败」。禁止再把所有上传异常写成「文件格式不符」。
   - `applyParsedData` 同时写入 `synthetic` 与 `上传数据 · 文件名`；上传成功提示按
     `screen.synthetic` 分流为 `ElMessage.warning`（未能真实解码）/ `success`。
   - upload 模式切时次：`clearLayer()` 后必须给文案「仅上传模式：点屏头「上传」加载文件」，
     空白画面不得无解释。
   - `noDataStatus()` / `nearestAvailableLabel()`：清单模式下「该时次无数据（最近可用 MM-DD HH:mm:ss）」；
     ★ 模板模式（`fileUrlTemplate`）一律不给“最近可用” ★ 模板地址是算出来的，给了就是臆测。
   - `versionCheck`：`warnedVersion` 去重，同一版本只弹一次「请按 Ctrl+F5」，
     修复每 5 分钟 / 每次切回前台重复弹（该分支受 sessionStorage 保护，永不刷新）。
   - `docs/USER_GUIDE.md`：状态表补齐 4 个上传失败原因 + 仅上传模式提示；修正 `.bz2`
     口径（已支持 `.bin.bz2`/`.m4.bz2`，浏览器内解压，不再要求先手工解压）。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。
   ⚠ 以下需浏览器人工确认（纯 UI 分支，无单测覆盖）：① 上传旧格式 RSTM → 红标「示意数据」
   与「上传数据 · 文件名」同时可见；② upload 模式切时次 → 出现模式提示；③ 清单模式拖到无文件
   时次 → 状态带「最近可用」；④ 上传 >200MB 文件 → 状态「文件过大」。

【2026-11-05 本轮改动（提示信息系统梳理：只评审，无代码变更）】

1. 修改文件：无（仅评审；结论落本文档，业务代码未改）

2. 修改目的：全面梳理用户可见提示（屏头状态 / ElMessage / tooltip / 面板与空态文案 / 控制台日志）
   与文档口径的一致性，形成分级优化清单供后续分批实施。

3. 关键规则沉淀（本轮确认的问题，实施时按此修）：
   - 屏头状态文案 7 处字符串散落在 `useRadarScreen.ts`，建议集中到 `src/constants/messages.ts`
     单一来源，同步 `docs/USER_GUIDE.md` §6 状态对照表，避免措辞漂移。
   - `ScreenState.status` 一个字段同时承载「数据来源标签」与「运行状态」：
     上传的合成/旧格式 RSTM（`isSynthetic=true`）只能显示「上传数据 · 文件名」，
     无法同时给出「示意数据」警示 —— 而 `AGENTS.md` 明确该标记禁止用于业务判断。
   - `applyParsedData` 未检查 `grid.isSynthetic` → 上传路径丢失「示意数据」提示（服务器取数路径有）。
   - `onUpload` 把所有异常都映射为「文件格式不符」，>200MB、`基数据体无有效数据` 等原因被误标为格式问题。
   - `dataSourceMode=upload` 切时次只 `clearLayer()` + `status=''`，画面空白且无任何解释文案。
   - `versionCheck` 的「Ctrl+F5」分支未做去重 → 每 5 分钟 / 每次切回前台重复弹同一条错误。
   - `FolderFiles` 空态「下次打开仍会记住」与下方「下次打开需重新选择文件夹」在 http 环境自相矛盾。
   - 空时间轴显示「1 / 0 时次」；坐标展示硬编码 `°N/°E`，负经度（西经）语义错误。
   - 文档漂移：`docs/USER_GUIDE.md` 仍写「`.bz2` 不支持 / 要先解压」，代码已支持浏览器端解压（`accept=".bin,.m4,.bz2"`）。
   - 控制台前缀已与文件不符（`useRadarScreen` 打 `[RadarScreen]`、`baseMap` 打 `[mapManager]`），排查时误导。

4. 验证方式：只读评审，`npx vue-tsc` / `npm test` 不受影响；优化项待批准后分批实施。

【2026-11-04 本轮改动（补充：恢复按钮可见性说明与环境提示）】

1. 修改文件：`src/components/FolderFiles.vue`、`src/styles.css`

2. 修改目的：用户看不到「恢复」按钮——截图里的组是早期 `webkitdirectory` 记录（无目录句柄），
   只能「需重选」；同时补充环境提示，避免误以为功能失效。

3. 关键规则沉淀：
   - 「恢复」按钮**只在组有 `handle`**（用 `showDirectoryPicker` 选择过）时显示；
     `webkitdirectory` 降级路径与历史记录没有句柄，只能「需重选」。
   - 面板在 `window.showDirectoryPicker` 不可用时显示环境提示（需 https / localhost），
     并在控制台打印自动恢复是否启用，便于现场排查。
   - 「需重选」标签改为**可点击**（打开选择器），重选同名目录即替换占位组恢复加载。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。

【2026-11-04 本轮改动（目录句柄持久化：免重选自动恢复）】

1. 修改文件：`src/types/fsAccess.d.ts`（新增）、`src/api/localFileStore.ts`（新增）、
   `src/api/localFiles.ts`、`src/components/FolderFiles.vue`、`src/styles.css`

2. 修改目的：跨会话后尽量不再需要重新选择文件夹即可加载文件。

3. 关键规则沉淀：
   - 双路径选择：`showDirectoryPicker`（Chromium + https/localhost）选择目录并把
     `FileSystemDirectoryHandle` 存入 IndexedDB；不支持时降级 `input[webkitdirectory]`。
   - 启动恢复：读句柄 → `queryPermission({mode:'read'})` 为 granted 时直接 `collectDirFiles`
     重新枚举（**完全无需操作**）；为 prompt 时建占位组并在父级显示「恢复」，
     点击触发 `requestPermission`（必须用户手势）后自动读取。
   - 只有 `FileSystemDirectoryHandle` 可结构化克隆进 IndexedDB；**File 不行**。
   - 句柄读写失败（隐私模式 / 老浏览器）全部降级为“结构占位 + 重选”，不影响既有功能。
   - ★ 环境限制 ★ 局域网 http（现网默认）下 `window.showDirectoryPicker` 为 undefined，
     拿不到句柄，此路径不生效；需要 **https 或 localhost**。
   - TS 补充声明集中放 `src/types/fsAccess.d.ts`（showDirectoryPicker / values /
     queryPermission / requestPermission）。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。
   ⚠ 免重选需浏览器实测（https/localhost + Chrome/Edge）：选目录 → 刷新 → 自动恢复或点一次「恢复」。

【2026-11-04 本轮改动（文件夹结构跨会话记忆）】

1. 修改文件：`src/api/localFiles.ts`、`src/components/FolderFiles.vue`、`src/styles.css`

2. 修改目的：下次打开浏览器仍能看到上次选择的文件夹结构（同一台电脑持久化）。

3. 关键规则沉淀：
   - **分层记忆**：结构（组名 / 文件名 / 大小 / 时次）写 localStorage（key 为 `radar:local-folders`）；
     文件内容（File）是浏览器安全对象，**无法**写入 localStorage / IndexedDB，故不持久化。
   - 恢复出的组 `ready=false`（占位）：不进入 byTime 索引、不参与按时间取数；文件行置灰，
     点击提示重新选择；父级显示「需重选」标签。
   - 重新选择**同名目录**时 `addLocalFolder` 用真实文件替换同名占位组，避免重选后出现重复组。
   - `LocalEntry.file` 允许 null、`LocalEntry.size` 保存记忆大小，供占位树展示。
   - localStorage 读写全部 try/catch：隐私模式 / 配额不足时静默降级，不影响当前会话。
   - 若要“自动加载”（无需重选），需改用 `showDirectoryPicker` + IndexedDB 存目录句柄，
     且要求 https/localhost + Chromium；现网 http 局域网不可用，故未采用。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。
   ⚠ 跨会话行为需浏览器实测：选择文件夹 → 刷新 → 仍显示结构（标记需重选）→ 重选同名目录后可加载。

【2026-11-04 本轮改动（文件夹选择改为累加 + 父级删除）】

1. 修改文件：`src/api/localFiles.ts`、`src/components/FolderFiles.vue`、`src/styles.css`

2. 修改目的：
   - 选择文件夹从“替换”改为“**累加**”：多次选择互不覆盖，会话内一直保留；
   - 每个顶层文件夹作为**父级节点**，父级后可「删除」整组（只有点击删除才删除）；
   - 空态提示说明刷新页面后需重新选择（File 无法持久化）。

3. 关键规则沉淀：
   - localFiles 改为多组结构 `LocalFolderGroup[]`（id / name / entries）：`addLocalFolder` 追加、
     `removeLocalFolder` 按 id 删除；`byTime` 索引在 add / remove 后整体重建（同组时次后加入者优先）。
   - 组 key 用 `'g' + id`（id 不复用），组内节点 key = 组 key + 路径，
     避免多组同名目录的折叠状态互相串台。
   - 删除按钮放在父级目录行内（`span @click.stop`），避免触发折叠；仅 `isGroupRoot` 显示。
   - 本地文件**仅在内存**：File 是浏览器安全对象，无法写入 localStorage / IndexedDB，
     刷新页面后需重新选择（浏览器限制，不是实现缺陷）。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。

【2026-11-04 本轮改动（文件夹文件按目录层级展示）】

1. 修改文件：`src/components/FolderFiles.vue`、`src/styles.css`

2. 修改目的：选择文件夹后按文件自带的相对路径（webkitRelativePath）还原目录层级树，
   替代原来的平铺列表。

3. 关键规则沉淀：
   - 用 `webkitRelativePath` 的 `/` 分段构建 DirNode 树，再按折叠状态扁平化为 visibleNodes；
     模板只渲染扁平数组 + 内联 `padding-left` 缩进（不引入递归组件，改动面更小）。
   - 目录默认全部展开；重新选择目录时重置 `collapsed`（避免旧路径残留）；
     目录节点显示其下（含子目录）文件数。
   - 树只影响展示：本地文件源（localFiles / localFileTimes）与取数逻辑完全不变。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。

【2026-11-04 本轮改动（新增构建版本检测，部署更新后自动刷新）】

1. 修改文件：`vite.config.ts`、`src/utils/versionCheck.ts`（新增）、`src/main.ts`、`src/types/env.d.ts`

2. 修改目的：部署新版本后，浏览器可能仍使用缓存的旧 index.html / JS，用户必须硬刷新才能看到新内容。
   改为构建时产出 `version.json` + 注入 `__APP_VERSION__`，前端定时比对并自动刷新。

3. 关键规则沉淀：
   - `vite.config.ts` 每次 build 生成版本号 `yyyyMMddHHmmss`：`define` 注入 `__APP_VERSION__`，
     并由插件 emit 出 `dist/version.json`（前端轮询源）。
   - versionCheck **仅在生产构建启用**（dev 有 HMR）；首次延迟 10s，之后每 5 分钟检查，
     页面切回前台时立即检查；页面隐藏时不刷新，避免后台标签丢状态。
   - 防死循环：sessionStorage 记录“已为该版本自动刷新过”，刷新后仍不一致则改为提示 Ctrl+F5，
     防止 index.html 被缓存时无限 reload。
   - 请求 `version.json` 带 `?t=时间戳` 绕过缓存；404 / SPA 回落成 HTML（JSON.parse 失败）时静默忽略。
   - ★ 部署依赖：nginx 必须对 `index.html` 与 `version.json` 返回 `Cache-Control: no-cache`
     （或很短过期），否则自动刷新后仍是旧内容（会退化为提示手动硬刷新）。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm run build` 成功，
   `dist/version.json` 产出 `{"version":"20261104134749"}`，且该版本号已内联进
   `dist/assets/index-*.js`（findstr 命中）。

【2026-11-04 本轮改动（仅上传模式隐藏时间轴与播放）】

1. 修改文件：`src/App.vue`、`src/components/Toolbar.vue`、`public/data/dataSourceMode.md`

2. 修改目的：`dataSourceMode=upload`（只通过上传文件）时界面不显示底部时间轴；
   播放按钮（按时间推进时次）随之隐藏，避免播放反复推进时次把上传画面清空。

3. 关键规则沉淀：
   - 时间轴 / 播放属于“时间切换”能力，与 upload 模式（无服务器数据、无时次切换入口）互斥：
     统一用 `appState.dataSourceMode !== 'upload'` 控制显隐（只在 UI 层判断，store 不改）。
   - upload 模式内部仍保留 `config.timeline` 生成的当前时次（用于绑定上传数据与屏头时间），
     只是不渲染 Timeline 组件，不影响上传后的切产品 / 切仰角局部刷新。
   - 同步更新 `public/data/dataSourceMode.md`：upload 模式“不显示时间轴”，
     常见问题表移除“切时次空白”，改为“看不到时间轴 / 播放按钮”。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。

【2026-11-04 本轮改动（本地文件夹文件接入时间轴）】

1. 修改文件：`src/api/localFiles.ts`（新增）、`src/api/radarManifest.ts`（导出 buildMetaFromFileName）、
   `src/store/appStore.ts`、`src/components/Timeline.vue`、`src/components/FolderFiles.vue`、
   `src/composables/useRadarScreen.ts`

2. 修改目的：选择文件夹后时间轴没有显示这些文件的时次——文件夹文件此前只列在侧栏，
   未登记为可用时次，时间轴（绿色刻度）与取数都看不到它们。

3. 关键规则沉淀：
   - 本地文件夹文件单独放 `api/localFiles.ts` + `store.localFileTimes`，**不合并进 `appState.files`**：
     files 会被 refresh 当成 URL 去 fetch，而本地文件没有可请求地址。
   - `timelineTimes` 合并本地时次（排序去重），使时间轴能吸附 / 步进到这些不在配置栅格上的时刻；
     `Timeline.fileTimes`（绿色刻度）同样合并 files + localFileTimes。
   - refresh 取数分支顺序：**本地文件（getLocalFile(time)）优先 → upload 模式短路 → 服务器取数**；
     本地文件用 `parseUploadedFile` 解析（自然支持 bz2 / RSTM 体数据仰角）。
   - 上传与本地文件共用 `applyParsedData`（体数据仰角 / 单层网格 / 色标范围 / 定位 / 状态文案），
     避免两条来源行为分叉。
   - 本地文件时次由文件名 14 位时刻解析（复用 `radarManifest.buildMetaFromFileName`）；
     无时刻的文件不进入时间轴，但仍可在列表里点击上传。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。
   ⚠ 需浏览器选择真实文件夹确认时间轴刻度与跳转加载（纯 UI 交互，无单测覆盖）。

【2026-11-04 本轮改动（补充：数据来源模式说明文档）】

1. 修改文件：`public/data/dataSourceMode.md`（新增）

2. 修改目的：把 dataSourceMode 三种模式（latest / upload / both）的行为差异、配置示例、
   注意事项与常见问题整理成文档，随 public/data 原样拷贝到 dist/data，现场可直接查阅。

3. 关键规则沉淀：
   - 文档放在 `public/data/` 而非 docs/：与 config.json / config.example.json 同目录，
     部署时随构建产物一起到达数据目录，便于运维对照配置排查。
   - 文档内容必须与 `App.vue` 初始化分支、`useRadarScreen.refresh` 的 upload 短路保持一致；
     后续改动这三种模式的行为时要同步更新该文档。

4. 验证方式：静态说明文档，无代码变更；`npx vue-tsc` / `npm test` 不受影响。

【2026-11-04 本轮改动（新增数据来源模式配置 dataSourceMode）】

1. 修改文件：`src/types/index.ts`、`src/api/configApi.ts`、`src/store/appStore.ts`、`src/App.vue`、
   `src/composables/useRadarScreen.ts`、`public/data/config.example.json`

2. 修改目的：config.json 新增 `dataSourceMode` 控制数据来源：
   - `latest`：只通过最新数据接口获取（查最新时间定位最新文件，不加载文件清单；上传保留）
   - `upload`：只通过上传文件（时间轴按配置生成，不查最新时间、不加载清单、不取服务器数据）
   - `both`  ：两者同时存在（清单 / 模板 / 最新时间 + 上传），默认

3. 关键规则沉淀：
   - `AppConfig.dataSourceMode` 为**可选**字段，缺省 / 非法值一律按 `both`，保证无配置部署行为完全不变。
   - App 初始化按 mode 分支：both 无模板才加载清单；latest 不加载清单（需配 `fileUrlTemplate`，
     否则 warn 且无数据可显示）；upload 不查最新时间（不自动跳时次，地图空白等待上传）。
   - refresh 取数分支前增加 upload 短路：首次 / 切时次的取数请求一律不发服务器，改为清空画面；
     上传后同屏切产品 / 仰角仍走局部更新（`layerTime === sc.time`），不受影响。
   - 上传入口在三种模式下**均保留**（latest / upload 都要能上传），UI 不按 mode 隐藏任何按钮。
   - upload 模式时间轴保留（按 config.timeline 生成），切时次地图空白（只有上传的那个时次有画面）。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。
   ⚠ 三种模式的端到端行为需在浏览器配合对应 config.json 人工确认（配置 + 状态机，无单测覆盖）。

   config.json 示例：`{ "dataSourceMode": "latest | upload | both", ... }`（缺省 both）

【2026-11-04 本轮改动（体数据切换产品重新栅格化）】

1. 修改文件：`src/composables/useRadarScreen.ts`

2. 修改目的：上传 / 取数的 RSTM 体数据切换产品（字段）时无变化或配色错乱——
   原局部更新分支只调用 updateRadarProduct 换色标，未按新字段重新栅格化。

3. 关键规则沉淀：
   - 体数据下「仰角层 + 字段」共同决定栅格内容：refresh 局部更新分支把
     `layerElevation !== sc.elevationIndex || layerProductId !== product.id` 合并为同一条件，
     统一 `volumeToGrid(currentVolume, elevationIndex, fieldForProduct(productId))` 重建图层。
   - 重建后必须同步 layerProductId / layerThreshold / layerSmooth / layerRange，
     否则后续判重会以旧口径误跳过或误重绘。
   - 非体数据（拼图 / m4 / 单层）切产品仍走 updateRadarProduct 换色标（无多字段可栅格化）。
   - 该分支被服务器取数与上传数据共用，服务器链路切产品同样获得修复。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。
   ⚠ 需浏览器用真实 RSTM 文件确认 dBZ / V / W 等产品切换的画面变化。

【2026-11-04 本轮改动（修复上传数据切仰角无响应 + 屏头显示上传文件名）】

1. 修改文件：`src/composables/useRadarScreen.ts`、`src/components/ScreenHeader.vue`、`src/styles.css`

2. 修改目的：
   - 修复上传数据后切换仰角无响应：refresh 的“完全没变化”判重漏了仰角字段；
   - 修复上传数据被服务器文件清单误判为“该时次无数据”；
   - 屏头状态显示上传文件名，便于多屏 / 多文件区分数据来源。

3. 关键规则沉淀：
   - refresh 判重必须包含仰角，且只在体数据下参与比较
     （`!currentVolume || layerElevation === sc.elevationIndex`）：
     非体数据 layerElevation 恒为 -1，无条件比较会永远判“有变化”而白走局部更新；
     漏比较则切仰角会被判重直接跳过（现象即“切换仰角无响应”）。
   - 局部更新分支（`layer && layerGrid && layerTime === sc.time`）必须排在文件清单解析之前：
     上传数据的文件不在数据服务清单里，先查清单会在清单模式下 clearLayer + “该时次无数据”，
     表现为切仰角画面被清空 / 无响应。只有需要重新取数的分支才解析 file。
   - 上传状态文案统一为 `上传数据 · <文件名>`；屏头 `.screen-status` 限制 max-width 40% + 省略号，
     并用 title 显示完整文件名（长文件名不挤压仰角 / 平滑 / 上传控件）。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。
   ⚠ 交互行为（上传后切仰角重绘、文件名显示）需在浏览器用真实 RSTM 文件人工确认（纯 UI 状态机，无单测覆盖）。

【2026-11-04 本轮改动（上传数据支持仰角选择）】

1. 修改文件：`src/api/radarSource.ts`、`src/composables/useRadarScreen.ts`

2. 修改目的：上传的 RSTM 基数据体文件也能像服务器取数一样出现仰角选择器（9 仰角层可切换），
   而不是被降级为单层合成网格。

3. 关键规则沉淀：
   - parseUploadedFile 返回值改为判别联合 UploadedRadarData：
     kind='volume'（RSTM 标准体数据，栅格化由调用方 volumeToGrid 按当前产品字段/仰角执行）/
     kind='grid'（拼图/m4/合成 RSTM 单层网格）。RSTM 魔数优先尝试 parseRstmVolume，
     结构校验失败回退单层合成兜底（原行为不变）。
   - onUpload 里层号需自行钳制到体数据实际层数（volumeToGrid 内部虽钳制但不回传实际层号，
     layerElevation 必须与 store 钳制后的 elevationIndex 一致，否则后续仰角切换会走错分支）。
   - 当前层无有效数据时回退最低仰角层，仍无数据抛错走上传失败提示。
   - TS 踩坑：`a ?? b`（b 可能为 null）直接赋给非空类型变量会在赋值语句处报错，
     后置 `if (!x) throw` 无法收窄赋值表达式类型——先落局部常量再判空。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 10 文件 73 用例全通过。

【2026-11-04 本轮改动（P0-1 解析补测试 + P0-2 取值逻辑抽纯函数）】

1. 修改文件：`src/parse/rstmRadials.test.ts`（新建）、`src/parse/valueQuery.ts`（新建）、`src/parse/valueQuery.test.ts`（新建）、`src/utils/gridSample.ts`（新建）、`src/render/radarRenderer.ts`、`src/composables/useRadarScreen.ts`、`AGENTS.md`

2. 修改目的：重构评估的 P0 两项 —— ① 补上 RSTM 二进制解析核心的测试（此前无覆盖）；② 把取值逻辑从 composable 抽出为纯函数并消除类型断言。

3. 关键规则沉淀：
   - **`rstmRadials.test.ts`（20 个用例）用“手工构造最小 RSTM 缓冲”而非 4.9MB 真实样本**：`buildBuffer(cuts, radials)` 只写解析器实际读取的偏移，覆盖魔数/版本/cut 数/库长校验、`(code-offset)/scale` 与 `code≤4` 缺测、8/16 位矩、dealias（折叠到 ±Nyquist）、长短圈按方位合并且**先到者优先**、Unix 时间换算、字段类型映射、方位升序
   - ★ 断言精度陷阱 ★ 字段是 `Float32Array`（约 7 位有效数字），`toBeCloseTo(..., 6)` 会因 1.5e-6 的误差失败，必须用 `..., 4`
   - ★ 网格取值测试的坐标陷阱 ★ 把点放在两个格点正中（如 xStart=118.825、点 118.83）时，浮点误差会让 `Math.round(0.5)` 落到 0 或 1 不确定；测试夹具必须让点**正好落在格点**上（xStart=118.82）
   - 取值逻辑下沉三层：`utils/gridSample.ts`（网格最近邻，纯函数，radarRenderer re-export 保持兼容）→ `parse/valueQuery.ts`（fieldForProduct/rawValueAt/queryValue）→ `useRadarScreen.showValueAt` 只剩弹窗与 ElMessage
   - `queryValue` 返回 `{...RadarQueryResult, visible, shown}`；`center`/`mean` 用 **`== null` 判断而不是 `!mean`**（九点均值恰为 0 时不能被误判成“无数据”，已加回归用例）
   - `RstmSample` 的字段名与 `RstmField` 一一对应，可直接 `sample[field]` 索引 —— 原来为绕过类型用了 `as unknown as Record`，属可消除的坏味道（`map as unknown as L.Map` 是 Leaflet 类型摩擦，保留）
   - 成果：`useRadarScreen` 431 → 404 行（取值逻辑整体移出）；测试 41 → **73 个（10 文件）**全绿；`vue-tsc` 通过

【2026-11-04 本轮改动（补充：上传/文件夹支持 .bz2 压缩文件）】

1. 修改文件：`src/api/radarSource.ts`、`src/components/FolderFiles.vue`、`src/components/ScreenHeader.vue`

2. 修改目的：让「上传」与「文件夹文件」支持常见的 .bz2 压缩雷达数据（.bin.bz2 / .m4.bz2），
   浏览器端用 seek-bzip 解压后再做格式识别。

3. 关键规则沉淀：
   - parseUploadedFile 改为按内容魔数 BZh（isBzip2Data）判断是否 bz2，解压后再走 m4/mosaic/RSTM 魔数识别；
     不依赖扩展名，改名/无扩展名的 bz2 也能正确解压，非 bz2 文件行为不变。
   - 文件体积上限 200MB 仍按压缩前 file.size 判定，与取数链路 fetchAndDecompress 一致（均不解压后体积）。
   - FolderFiles 过滤与 ScreenHeader accept 同步加入 .bz2；.bin.bz2 的扩展名按 .bz2 匹配。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；解压复用既有 seek-bzip（utils/bzip2.ts），
   无新增依赖。

【2026-11-04 本轮改动（新增：选择本地文件夹并加载文件）】

1. 修改文件：`src/composables/uploadRouter.ts`（新增）、`src/components/FolderFiles.vue`（新增）、
   `src/composables/useRadarScreen.ts`、`src/App.vue`、`src/styles.css`

2. 修改目的：新增「选择文件夹」功能——左侧侧栏新增「文件夹文件」区块，用户可选择一个本地目录，
   列出其中的雷达数据文件（.bin / .m4），点击某文件即加载到当前激活屏解析渲染（复用现有上传链路）。

3. 关键规则沉淀：
   - 文件夹选择用 `<input type="file" webkitdirectory multiple>`（递归收集子目录文件），
     不用 `window.showDirectoryPicker`：后者要求安全上下文（https/localhost），
     现网经局域网 IP 以 http 访问时不可用；`webkitdirectory` 在普通 http 下也能用。
   - 跨组件把文件路由到「激活屏」通过 `uploadRouter` 模块级处理器表实现：
     每屏 useRadarScreen 挂载时 registerUploadHandler、卸载时 unregister；
     侧栏按 appState.activeScreenId 查找调用。处理器表用普通 Map（不进 reactive）。
   - 文件列表只收 `.bin/.m4`（与屏头上传 accept 一致，parseUploadedFile 仅支持这两种；
     .bz2 上传暂不支持，与既有 upload 行为保持一致，不扩大范围）。
   - File 对象内容延迟读取：webkitdirectory 只取文件元数据，点开时才 arrayBuffer()。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；新增为纯 UI 层，不影响既有
   `npm test` 纯逻辑单测。

【2026-11-02 本轮改动（P2：mapManager / cinradVolume 拆分 + RSTM 解析优化 + vendor 分包）】

1. 修改文件：`src/render/mapManager.ts`（收敛为门面）、`src/render/mapFactory.ts`（新增）、
   `src/render/baseMap.ts`（新增）、`src/render/mapLink.ts`（新增）、
   `src/parse/cinradVolume.ts`（收敛为门面）、`src/parse/rstmRadials.ts`（新增）、
   `src/parse/rstmPolar.ts`（新增）、`src/parse/rstmGrid.ts`（新增）、
   `src/parse/rstmPolar.test.ts` / `src/parse/rstmGrid.test.ts`（新增）、
   `vite.config.ts`、`AGENTS.md`、`CLAUDE.md`

2. 修改目的：继续收敛超大文件，并处理 RSTM 解析/栅格化的低风险热点：
   - `mapManager.ts`（原 398 行）拆为建图 / 底图 / 联动；
   - `cinradVolume.ts`（原 937 行）拆为解析 / 极坐标取样 / 栅格化；
   - 解析阶段减少临时对象分配，栅格化结果支持多屏复用；
   - 构建产物做 vendor 分包，改善浏览器缓存。

3. 关键规则沉淀：
   - mapManager 继续 re-export 原有 API；`unregisterMapLink` 门面同时做“解除联动 + cleanupBaseMap”，
     mapLink 只管理连接表，不 import baseMap，避免循环依赖。
   - cinradVolume 继续 re-export 原有 API；调用方 import 路径不变。依赖方向：
     cinradVolume → rstmRadials/rstmPolar/rstmGrid；rstmGrid → rstmPolar/rstmRadials。
   - RSTM 解析性能：整个文件只建一个 DataView；8 位矩用 Uint8Array；空字段共享零长数组；
     矩类型→字段名用预建反向表（旧实现每次 new DataView / 每条径向 9 个空数组 / 每矩线性查找）。
   - `volumeToGrid` 用 `WeakMap<volume, {key, grid}>` 只缓存最近一次（约 3MB/volume），
     多屏同层同字段直接复用；返回的 grid 只读，禁止改 data/time。
   - 地面距离→斜距改为按仰角缓存的 100m 步长 LUT（`groundToSlantFast`），
     单点从 24 次三角/开方降为一次二分+插值；测试保证与二分实现误差 <1m。
   - `vite.config.ts` manualChunks：vue / element-plus / quickearth 独立 chunk；
     只改变切分，不减少首屏总字节。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 8 个文件 41 个用例全通过
   （新增 rstmPolar 的斜距/极坐标往返、rstmGrid 的栅格化/缓存/LUT 精度用例）；`npm run build` 成功，
   产物拆为 `vue-CqWsrJRt.js` 70.01 kB、`index-CNeZ6BGI.js` 96.59 kB、
   `element-plus-9k96HH6D.js` 936.20 kB、`quickearth-DwTJjkYN.js` 1,042.30 kB，CSS 386.84 kB。
   ⚠ 未用真实 RSTM 文件做端到端基准（本机 `public/data` 无雷达文件）；本轮性能改动为结构性/微观优化，
   实际收益需在现场数据上复测。


【2026-11-02 本轮改动（P1 结构拆分：radarApi 分层 / RadarScreen 组合化 / 时间格式化）】

1. 修改文件：`src/api/radarApi.ts`（收敛为门面）、`src/api/radarCache.ts`（新增）、
   `src/api/radarManifest.ts`（新增）、`src/api/radarSource.ts`（新增）、
   `src/composables/useRadarScreen.ts`（新增）、`src/components/RadarScreen.vue`（薄壳）、
   `src/components/ScreenHeader.vue`（新增）、`src/components/CoordinateQuery.vue`（新增）、
   `src/components/ProductList.vue`、`src/components/Timeline.vue`、`src/types/index.ts`、
   `src/utils/datetime.ts`、`src/api/radarCache.test.ts`（新增）、`AGENTS.md`、`CLAUDE.md`

2. 修改目的：把两个超大文件拆成职责单一的小模块，行为保持不变：
   - `radarApi.ts`（原 800+ 行）拆为“门面 + 清单发现 + 下载解析 + 缓存/共享任务”；
   - `RadarScreen.vue`（原 750 行）拆为“薄壳 + 地图/图层 composable + 屏头 + 坐标查询面板”；
   - 顺手统一时间短文本、显示序号与稳定 id 解耦。

3. 关键规则沉淀：
   - `radarApi` 继续 re-export `fetchRadarFileList` / `buildFileMetaFromTemplate` / `parseUploadedFile` /
     `RadarFileMissingError`，调用方 import 路径不变；内部依赖方向为
     radarApi → radarSource/radarManifest/radarCache，radarSource → radarManifest/radarCache。
   - `SharedTask` + `LruCache` 移到 `radarCache.ts`：网格/体数据缓存共用同一套“条数 + 字节”淘汰；
     体数据失败 buffer 暂存移到 `radarSource.ts`，负缓存仍留在 radarApi 的取数编排里。
   - `useRadarScreen` 集中保存 8 个图层状态变量、refreshToken/inflight、fitToGrid、取样与上传；
     RadarScreen 只组合子组件，禁止再把地图/图层逻辑写回模板组件。
   - `CoordinateQuery` 通过 `sample(lat, lon, notify)` 回调注入取样，不持有地图/图层；
     地图弹窗与面板结果共用同一次取样（保证“面板数值 = 图上弹窗”）。
   - `RadarQueryResult` 移入 types/index.ts；时间短文本统一 `formatShortTime`，
     ProductList / Timeline / ScreenHeader 不再手写 `replace('T',' ').slice()`。
   - 展示序号与稳定 id 解耦：ScreenHeader / ProductList 用数组位置 +1，不再假设 `id === 下标`；
     产品名统一 `getProductByIdSafe`（服务器目录未落库时也能回退静态目录）。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 6 个文件 34 个用例全通过
   （新增 radarCache 的 5 个 LRU 用例）；`npm run build` 成功，产物 `dist/assets/index-BlbOCqUK.js`
   1,616.54 kB（gzip 473.08 kB）、CSS 386.84 kB（gzip 57.31 kB）。
   本轮只做结构迁移，未改渲染/解析算法；手工回归重点仍是多屏播放、切产品/平滑、坐标查询、上传。

【2026-11-02 本轮改动（P0 稳定性：取数并发 / 缓存 / 时区 / 播放状态 + Vitest）】

1. 修改文件：`src/api/radarApi.ts`、`src/store/appStore.ts`、`src/components/RadarScreen.vue`、
   `src/components/TimeAxis.vue`、`src/App.vue`、`src/api/configApi.ts`、`package.json`、
   `vitest.config.ts`（新增）、`src/api/radarApi.test.ts` / `src/api/configApi.test.ts` /
   `src/store/appStore.test.ts` / `src/utils/datetime.test.ts` / `src/utils/range.test.ts`（新增）、
   `AGENTS.md`、`CLAUDE.md`

2. 修改目的：先处理“会让屏永久停在加载中 / 重复下载 / 内存不可控”的 P0 边界，
   再为后续拆 RadarScreen 与 radarApi 建立最小回归测试基线。

3. 关键规则沉淀：
   - 共享任务（SharedTask）把“调用方等待”与“底层下载”分离：每个调用方只取消自己的等待，
     waiters 归零才 abort；禁止再把第一个调用方的 AbortSignal 直接传给共享 fetch。
   - AbortError 不再静默 return：RadarScreen 清 `ScreenState.loading` 与 status（保留旧画面），
     否则 App 的播放避让会永久跳过。
   - `ScreenState.loading` 与 `status` 解耦：播放避让读 loading；syncPlay=true 等全部屏，
     false 只等激活屏；禁止比较 `'加载中…'` 字符串。
   - RSTM 非标准文件：`fetchAndDecompress` 统一“下载+解压”；`parseRstmVolume` 返回 null 时
     暂存已解压 buffer（上限 2）供 `fetchRadarGrid` 回退复用；`noVolumeFiles` 负缓存（上限 20）
     避免每次切时次重复试解析。最多下载一次。
   - 缓存双重上限：grid 12 条 / 160MB、volume 3 份 / 384MB，超限按 LRU 淘汰且至少保留 1 条；
     App 卸载时调用 `clearGridCache` / `clearVolumeCache`。
   - 时间语义：TimeAxis 刻度改用 `msToISO`（固定北京时间），禁止 `new Date().getHours()`；
     `maxSpanHours` 改普通函数（timesMs 非响应式，computed 会永久缓存旧跨度）；
     `snapNearestTime` 改用 `isoToMs`。
   - Vitest 1.6：`npm test` / `npm run test:watch`；测试用 2×2 MICAPS m4 文本，
     不依赖真实雷达大文件，也不 import QE/地图模块。

4. 验证方式：`npx vue-tsc --noEmit -p tsconfig.json` 通过；`npm test` 5 个文件 28 个用例全通过；
   `npm run build` 成功（vue-tsc + vite build）。并发用例覆盖“单方取消不影响其它屏 /
   全部取消才中止下载 / 缓存命中不重复请求”。

【2026-10-27 本轮改动（新增用户使用手册）】

1. 修改文件：`docs/USER_GUIDE.md`（新增）、`AGENTS.md`（§2 与 §3 加入索引）

2. 修改目的：`PRODUCT_GUIDE.md` 是开发者向（新增产品/改色标/调渲染），`DEPLOY_GUIDE.md` 是运维向，
   缺一份给**值班/业务使用者**看的操作说明。

3. 关键口径沉淀（手册内容均来自组件实测，非臆写）：
   - 默认值：1 屏 / `border` 底图 / 产品 `dBZ` / 不平滑 / 全范围 / `syncPlay=true` + `syncMap=true`
   - ★刻度轴拖拽松手会**吸附最近时次**，而右侧时间跳转框**不吸附**（按分钟精确定位）——
     当前数据时刻带秒（`00:01:31` 等），用跳转框选时间几乎必为“该时次无数据”，手册里已当突出一条写
   - 屏头 7 种状态文案全部入表（`加载中…`/`该时次无数据`/`加载失败`/`示意数据`/
     `识别中…`/`上传数据`/`文件格式不符`）；★ `FetchTimeoutError` 不会单独成为状态，
     超时在 `refresh()` 的 catch 里**归入「加载失败」**（只有 `RadarFileMissingError` 升到「该时次无数据」）★；
     并单独标记**「示意数据」禁止用于业务判断**
   - 上传只收 `.bin,.m4`（文件选择框 `accept` 即此两项），**`.bz2` 不支持**，单文件上限 200MB
   - “图上透明”三种成因分开说明（低于显示阈值 / 色标范围裁掉 / 真缺测）；原始值 vs 9 点均值该信哪个
   - V/W 仅短距离圈采集、高仰角波束越过浅层、速度折叠 —— 这些“看起来像 bug”的数据特性归入读图/FAQ

4. 验证方式：文档为纯新增，无代码变更（不需 `vue-tsc`）；所有界面文案、默认值、交互描述已逐项回查
   `Toolbar.vue` / `ProductList.vue` / `RadarScreen.vue` / `Legend.vue` / `Timeline.vue` / `appStore.ts` / `products.ts`。

【2026-10-26 本轮改动（环境配置 .env 化 + 生产改内网天地图 WMTS）】

1. 修改文件：`.env.development`、`.env.production`、`.env.example`（新增）、
   `src/types/env.d.ts`（新增）、`src/config/dataSource.ts`、`src/render/mapManager.ts`、`.gitignore`、`AGENTS.md`、`CLAUDE.md`

2. 修改目的：把 dev/prod 的差异从源码里抽到 `.env`，同时把行政底图从公网 DataServer
   换成生产内网 WMTS 节点（`http://10.1.65.144:81/{vec_w|cva_w}/wmts`，tk `449b5f7b…`）。
   诱因：`DATA_BASE_URL` 被改成 `/data/radarData/`（匹配现网 nginx）后，开发环境只剩
   Vite 代理的 `/radar-data` 一条路径，dev 取数全部 404 —— 两个环境必需不同前缀。

3. 关键规则沉淀：
   - 变量：`VITE_DATA_BASE_URL`（dev `/radar-data/`、prod `/data/radarData/`）、
     `VITE_TILE_SERVICE_BASE`（dev 留空=公网、prod 内网 IP）、`VITE_TIANDITU_KEY`（两个 tk 不通用，必须成对）
   - **只有 `VITE_` 前缀会进入产物，且是构建时内联的字面量** → 改 .env 必须重启 dev / 重新 build；
     只替换服务器上的 `dist` 而不重建，或只改 nginx 不核前缀，都会静默错环
   - `DATA_BASE_URL` 加了**尾斜杠兜底**：漏一个 `/` 会拼成 `/data/radarDataZ_RADR_….bz2`，
     不报错、全量 404，是环境配置里最贵的一种错
   - 前缀与 nginx 数据 location 不一致时，请求落到 SPA 的 `try_files … /index.html` 回落，
     返回 **200 的 HTML** 而不是 404；前端把 HTML 当二进制解 → 合成兜底 → 屏头“示意数据”假回波
     （实测：`/radar-data/manifest.json` 与 `…bin.bz2` 均返回 `200 text/html 493B`）
   - WMTS 参数陷阱：**路径**用带切片集后缀的 `vec_w/cva_w`，**`LAYER=` 参数**用去后缀的 `vec/cva`；
     `TILEROW` 在 `w` 切片集里自上而下编号，与 Leaflet 的 `{y}` 同向，**不能做 TMS 翻转**
   - 内网是单节点 → 去掉 `subdomains`；新增 `maxNativeZoom`：省市级节点常只同步到 10~12 级，
     低于 18 时把该值改成实际最高层级，否则放大到底图整片 404 变空白
   - ★瓦片是**浏览器直连**，不是服务端代理★ 每台客户端必须可达该内网 IP；不可达时走
     nginx 同源反代 `/tianditu/` 并把 base 改成 `/tianditu`（https 站点下 http 瓦片会被混合内容拦截）
   - `env.d.ts` 必须是无 import/export 的全局脚本，否则 `ImportMetaEnv` 合并失效；
     字段全部 `?:` 可选，未知 mode（如 `--mode staging`）读到 undefined 时走读取处兜底
   - `.gitignore` 只新增忽略 `.env`；`.env.development/.env.production` **故意提交**
     （值是已暴露在前端的地址与 tk，不提交会让新克隆静默退回 dev 默认值）；
     现场专有值用 `.env.production.local`（已被原有 `*.local` 规则忽略）

4. 验证方式：`npx vue-tsc --noEmit` 通过；`loadEnv` 实测三组值（development 走代理前缀与公网 tk、
   production 走 `/data/radarData/` 与内网 tk、staging 返回 `{}` → 兜底生效）；
   `npm run build` 产物内 `/data/radarData/`、`http://10.1.65.144:81`、内网 tk 均存在，
   公网 tk 未泄漏进生产包；`GetProblems` 0 诊断。
   ⚠ 本机 curl `10.1.65.144:81` 四次全 `000`（不在该网段），**瓦片实际能否出图尚未验证**，
   需在可达机器上拉一张 z=6 瓦片确认 200 + `image/png`。

【2026-10-21 本轮改动（修正默认产品 id 与图例标题重复）】

1. 修改文件：`src/store/appStore.ts`、`src/App.vue`、`src/parse/mosaicParser.ts`、`src/parse/micapsM4Parser.ts`、`src/parse/cinradParser.ts`、`src/components/Legend.vue`、`src/components/ProductList.vue`、`CLAUDE.md`

2. 修改目的：进入页面时默认产品显示不对 —— 屏头/各屏状态显示原始的 `Z`，图例标题出现「反射率（dBZ）（dBZ）」。

3. 根因与修复：
   - 产品目录改成 dBZ/dBT/V/W/ZDR/CC/KDP/SNRH 后，**默认 `productId` 仍是旧的 `'Z'`**：产品列表里找不到该 id → 屏头与各屏状态回退显示原始 id「Z」，产品项高亮也匹配不上
   - 三处默认值统一改为 `'dBZ'`：`createScreens()`、`setLayout()` 的 base 兜底、`EMPTY_SCREEN`；`App.vue` 的 `?? 'Z'` 与三个解析器的 product 兜底同步改
   - 图例标题改为**只显示产品名**（名称里已括注产品代码），单位不再重复拼接（「反射率（dBZ）」而不是「反射率（dBZ）（dBZ）」）
   - 产品列表：tooltip 改用 `p.name`；名称已含单位时**隐藏右侧单位列**（避免「反射率（dBZ） … dBZ」）
   - ★ 规则：产品 id 是 `config/products.ts` 与 `public/data/products.json` 的契约，默认值/兜底值必须用同一套 id，不能留旧代码 ★
   - 验证方式：`vue-tsc` 通过；默认 productId 能在目录中命中、产品名均括注自身 id、无重复括号等断言全部通过（临时脚本已删除）

【2026-10-21 本轮改动（坐标查询独立成面板 + 增加九点均值）】

1. 修改文件：`src/parse/cinradVolume.ts`、`src/components/RadarScreen.vue`、`src/components/Legend.vue`、`src/styles.css`、`AGENTS.md`、`CLAUDE.md`

2. 修改目的：① 把经纬度查询从色标图例里拿出来，做成地图左下角的独立面板；② 面板同时给出「原始值（最近邻）」与「9 点均值（3×3 邻域）」，便于对照。

3. 关键规则沉淀：
   - 新增 `sampleRstmNeighborhood(volume, lat, lon, layerIdx, field, radius=1)` → `{ center, mean, validCount, totalCount }`
   - ★ 邻域必须按“**有该字段数据的径向**”向外扩展，不能用数组下标 ±1 ★：层里混着长短圈和“只有部分字段”的残缺径向（实测约 **18%** 的径向没有 dBZ 矩），下标 ±1 会连续踩空，9 点只剩 3 个有效、均值直接失效
   - 均值口径：只统计有效库；有效数 < **5** 时不给均值（避免 1~2 个样本不可靠）；方位索引环绕 0°/360°
   - 实测该点（33.6378, 118.9269，0.5° 层 dBZ）：center **-5.00**、mean **-0.89**（9/9 有效）；强回波点 48.5 → 邻域 40.7（印证“平滑压低峰值”）；速度 V -7.00 → -8.11
   - **速度场是标量平均**（未做 u/v 分解），跨零速度线会得到伪小值，UI 上按“参考值”看待
   - UI：`.coord-query` 固定地图左下角（z-index 1200），色标图例仍在右下角；面板内就地显示原始值 / 9 点均值（含 x/9 有效）与说明（低于阈值、超出范围、无数据）
   - `Legend.vue` 只保留色标与范围手柄，不再有查询输入（`emit('query')` 已移除）
   - 验证方式：`vue-tsc` 通过、0 诊断；九点邻域断言（9/9 有效、均值≠中心值、峰值不被抬高、范围外全 null）全部通过（临时脚本已删除）

【2026-10-21 本轮改动（经纬度分开输入）】

1. 修改文件：`src/components/Legend.vue`、`src/styles.css`、`AGENTS.md`、`CLAUDE.md`

2. 修改目的：图例底部的坐标查询原来是单框「经度, 纬度」，改为**经度、纬度分开两个输入框**（更直观、少一次格式约定）。

3. 关键规则沉淀：
   - 两个输入框 `flex: 1 1 0` 等分，查询按钮 `flex: 0 0 auto` 不被挤扁（图例总宽 220px，各框约 88px）
   - 校验按字段分别提示：经度 -180~180、纬度 -90~90、非数字、缺项
   - **容错**：把「118.9269,33.6378」整串粘进经度框且纬度框为空时，自动按逗号/空格拆成两个值
   - 两个框都支持回车提交；容器仍保持 `@pointerdown.stop`（否则触发浮层拖拽、输入框拿不到焦点）
   - 验证方式：`vue-tsc` 通过、0 诊断；交互需在浏览器确认

【2026-10-21 本轮改动（取值区分“有值但图上透明”与“真无数据”）】

1. 修改文件：`src/components/RadarScreen.vue`、`CLAUDE.md`

2. 修改目的：用户查 (33.6378, 118.9269) 得到“没有查到”，但该点原始值确实是 **-5.00 dBZ**。原因是 dBZ 产品首个可见档为 5 dBZ，取值口径「图上透明 = 取值空」把弱回波判成了无数据。

3. 关键规则沉淀：
   - 取值分三支：① 图上可见 → 显示网格值（与图面颜色一致）；② **有值但被阈值/色标范围挡住 → 仍然给出数值 + 原因**（如「-5.0 dBZ，低于显示阈值 5 dBZ（图上透明）」）；③ 真无数据（超出网格范围/库缺测）→ 输入查询提示“无数据”，点击地图静默
   - 分支 ② 的数值优先取 `sampleRstmValue`（极坐标原始径向，无网格量化），退回 `sampleGridValue`（不传阈值/范围）
   - 实测该点：极坐标原始值 **-5.00 dBZ**（方位 12.01°、44.8km、gate 179）；0.01° 网格值为 4.00 dBZ（1.1km 网格量化 + 邻域回找所致）→ 提示里用原始值更符合直觉
   - 若希望弱回波也上图：改 `src/config/products.ts` 里 dBZ 首个非透明档（现为 5），同步 `public/data/products.json`；注意降太低会把噪声/地物杂波一起上色
   - 验证方式：`vue-tsc` 通过；三分支断言（目标点走②并给出 -5.0、强回波走①、范围外走③）全部通过（临时脚本已删除）

【2026-10-21 本轮改动（取值补上「地面距离 → 沿波束斜距」换算）】

1. 修改文件：`src/parse/cinradVolume.ts`、`CLAUDE.md`

2. 修改目的：用户确认取值口径（4 步），其中第 3 步「按径向实际仰角把距离换算成沿波束距离再选库」此前缺失 —— 原先直接用地面大圆距离当斜距。

3. 关键规则沉淀：
   - 取值 4 步：① 经纬度 → 方位角 + 地面距离（Haversine）；② 方位角 → 该字段**有数据**的最近径向（保留原始 0.98°/0.99° 分辨率，长短圈分别找）；③ 地面距离按**径向实际仰角**换算成沿波束斜距，再选距离库；④ `(code − Offset) / Scale`，`code ≤ 4` 缺测
   - 换算公式（4/3 地球等效半径）：`h = sqrt(s² + kRe² + 2·s·kRe·sinθ) − kRe`，`r = kRe·asin(s·cosθ/(kRe+h))`；反解 `groundToSlantRange` 用二分（地面距离随斜距单调）
   - 影响量级：0.5° 460km 差 0.69km（3 库）；6° 230km 差 2.0km（8 库）；19.5° 123km 差 **8.2km（33 库）**，19.5° 100km 的 gate 由 399 → 425
   - 反向也要换算：`volumeToGrid` 计算覆盖范围时用 `slantToGroundRange`（19.5° 层 123km 斜距对应地面半径约 115km）
   - ★ UI 的“点击地图/输入经纬度”走的是 `sampleGridValue`（栅格化后的 0.01° 网格最近邻 + 邻域回找），不是 `sampleRstmValue`（纯极坐标取样）；实际链路还多一次约 1.1km 的网格量化 ★
   - 验证方式：`vue-tsc` 通过；换算往返一致（<1m）、各仰角影响量级、19.5° 层地面覆盖 < 123km 等断言全部通过（临时脚本已删除）

【2026-10-21 本轮改动（移除地图角落版权标识）】

1. 修改文件：`src/render/mapManager.ts`、`src/styles.css`、`CLAUDE.md`

2. 修改目的：去掉地图左下角出现的 "@QuickEarth" 小字标识（平台自带色标图例，不需要地图内版权条）。

3. 关键规则沉淀：
   - QE 的 `LMap` 构造器本身已把 `attributionControl` 置为 false（源码：`attributionControl` 非 true 时强制设为 false），本项目的 `createRadarMap` 又显式声明了一次，防 QE 版本变化
   - 底图/图层是异步初始化的，仍可能再挂上 attribution 条 → `createRadarMap` 里 `stripAttribution(container)` 立即清一次 + 800ms 后再清一次（`map.getContainer()`，注意入参是 `string | HTMLElement`，不能用原始参数）
   - CSS 兜底：`.leaflet-control-attribution { display: none !important }`
   - 备注：切到「行政」底图时天地图的 attribution 也会被一并隐藏；如有版权合规要求，可改成只隐藏 QE 标识、保留天地图来源
   - 验证方式：`vue-tsc` 通过；若刷新后仍可见，需要用户右键「检查」提供该元素 outerHTML（QE 包内不存在 "QuickEarth" 文本，说明它不是 QE 的 DOM 元素）

【2026-10-21 本轮改动（图例内经纬度查询）】

1. 修改文件：`src/components/Legend.vue`、`src/components/RadarScreen.vue`、`src/styles.css`、`CLAUDE.md`

2. 修改目的：除了地图点击，还能直接输入经纬度查询该点的数值。

3. 关键规则沉淀：
   - 输入框放在图例浮层底部（每屏独立，自动跟随本屏产品/时次/仰角/色标范围）
   - 格式「经度, 纬度」，支持中英文逗号与空格分隔；回车或点「查询」提交；校验范围 ±180 / ±90，非法输入在输入框下方红字提示
   - **取值必须复用 `RadarScreen.showValueAt(lat, lon, notify)`**：与地图点击同一口径（`firstVisibleThreshold` + `valueRange`），保证“输入查到 = 图上有点击结果”
   - 无数据时：点击地图静默关弹窗；输入查询用 `ElMessage.warning` 提示（否则“查了没反应”）
   - ★ 输入框容器必须 `@pointerdown.stop` ★ 否则按下输入框会触发图例浮层拖拽并 `setPointerCapture`，输入框拿不到焦点（与重置按钮同一坑）
   - 实测（同时次 03:17 的 0.5° 层 dBZ）：站点 (33.243,118.826) → -10.0 dBZ；西北 60km → 3.0 dBZ；范围外/远距离 → 提示无数据

【2026-10-21 本轮改动（支持经本机 IP 局域网访问）】

1. 修改文件：`vite.config.ts`、`AGENTS.md`

2. 修改目的：dev 服务原来 `host: 'localhost'` 只监听回环地址，其它设备无法用本机 IP 访问。

3. 关键规则沉淀：
   - `server.host: true`（监听 `0.0.0.0`/`::`），启动日志的 **Network** 地址即可用；`preview` 也补了 `port: 4173, host: true`
   - 实测：监听 `::`，`http://192.168.0.128:5179/` 与 `/radar-data/` 均返回 200
   - 本机多网卡（VMware 192.168.247.1 / 192.168.17.1）属于虚拟网段，局域网访问用**物理网卡地址**（本次为 192.168.0.128）
   - 其它设备访问被拒时先查 Windows 防火墙：需放行 Node.js 入站或 5179 端口
   - 切到「行政」底图时，用 IP 访问可能因天地图 key 的域名白名单不出图；默认「国界」底图不受影响
   - `/radar-data/` 的代理目标仍是 `localhost:9099`（服务端侧转发），客户端无需直连 9099

【2026-10-21 本轮改动（默认底图改为国界）】

1. 修改文件：`src/store/appStore.ts`、`src/types/index.ts`

2. 修改目的：启动即为「国界」矢量底图（原默认是天地图「行政」）。

3. 关键规则沉淀：
   - `appStore.baseMap` 默认值 `'admin'` → **`'border'`**；`RadarScreen` 挂载时读该值，新屏/布局扩展自动跟随
   - 工具栏按钮高亮直接绑定 `appState.baseMap`，无需额外改动
   - 副作用：首屏会加载约 4MB 边界 GeoJSON（worldGJ/chinaGJ/chinaSJ），加载期间先显示海洋色（`#97b6e1`），随后陆地与界线出现；数据加载完会缓存 Promise，切屏不重复加载
   - 好处：不依赖天地图 key，弱网/离线也能看出地理轮廓

【2026-10-21 本轮改动（方案 A：保留精确方位，不再量化到 1°）】

1. 修改文件：`src/parse/cinradVolume.ts`、`src/types/index.ts`（nyquist 字段）、`CLAUDE.md`

2. 修改目的：减小 JS 解析与服务端 m4 的重采样差异（用户选择方案 A）。

3. 关键规则沉淀：
   - 解析不再按 1° 量化合并：长短圈全部径向保留（0.5° 层 **730 条**），只按 `azimuth.toFixed(3)` 去重
   - 新增 `findNearestRadialIndex(layer, azimuth, field)`：二分定位方位夹缝 + 向两侧各 8 条找“该字段有数据且方位差最小”的径向 —— 长圈（460km，无 V/W）与短圈（230km，有 V/W）必须按字段分别找
   - `sampleRstmValue` 逐字段独立找径向（dBZ 作“有无回波”的判定基准）；`volumeToGrid` 用 index 版以便邻域回找
   - 实测收益（同时次 03:17:55 vs m4）：150km+ 平均差 **3.97 → 2.04** m/s，60-100km 2.03 → 1.91，100-150km 1.20 → 1.06；“仅 m4 有值” 80 → **30** 点；方位步长 0.98° → **0.49°**（长/短圈交错）
   - 性能：栅格化 V 51ms / dBZ 93ms（24 万点），未变慢
   - **0-30km 仍有 5.12 m/s 差异**：V 只有短圈 363 条（0.99°），方位分辨率无法再提升；且 m4 由服务端网格化（算法未知，疑似做过平滑/面积平均），近距离速度梯度极大（30km 处 0.5° 只跨 0.26km）。想进一步接近只能做邻域平均（会磨平小尺度细节），需用户确认

【2026-10-21 本轮改动（V 差异归因 + 层 Nyquist 修正）】

1. 修改文件：`src/parse/cinradVolume.ts`、`src/types/index.ts`、`CLAUDE.md`

2. 修改目的：用户问“JS 解码与 Python/m4 结果为什么有差别”。经四类归因分析给出结论，并修正一个实际问题（层 Nyquist 记成了长圈的 8.65）。

3. 差异归因（同时次 03:17:55，逐格点实测）：
   - **主因是重采样口径，不是解码**：差异 >5 m/s 的点中 **93.6%** 在我们 ±3 格邻域内能找到与 m4 相差 <1.5 的值 → 同一物理点被采到相邻格
   - 距离分段：0-30km 平均差 4.74（差>5 占 33.6%）、30-60km 3.83、60-100km 2.03、100-150km 1.20、150+ 3.97 —— 越近越大，因为 1° 方位在 30km 处只跨 0.5km，而径向是 250m，速度梯度大
   - 网格原点不同：我们 xStart=116.456 / yStart=34.919，m4 是 116.35 / 35.31（错开约 10 格）
   - 方位量化：原始每圈 363~368 条（0.98°/0.99°），我们量化到 1°（360 桶）并合并长短圈
   - 邻域回找：我们有效点 23.9% vs m4 16.4%，“仅我们有值” 2208 点，“仅 m4 有值” 80 点（0.96%）
   - 速度折叠 vs 二维解缠：|v| > Nyquist-0.5 的点仅 **0.05%**，影响面很小，不是主因
   - 缺测判定（code≤4）、解码公式 `(code-Offset)/Scale` 完全一致
   - ★ 对比 m4 必须用同时次（m4 03:17:55 ↔ bz2 `Z_RADR_I_Z9517_20261018031755_...`）
   - **修正**：`RstmRadial` 增加 `nyquist` 字段；逐字段合并 V/W 时同步切换 Nyquist；层 `nyquists` 取“V/W 实际来源圈”的值（0.5°/1.5° 由 8.65 → **27.23**）

【2026-10-21 本轮改动（V 按奈奎斯特速度折叠，与 m4 产品对齐）】

1. 修改文件：`src/parse/cinradVolume.ts`、`CLAUDE.md`

2. 修改目的：用户上传服务端生成的 m4（`Z9517_..._V_C02_E00.50.m4`）对比，希望我们解析的 RSTM 显示效果与之一致。

3. 关键规则沉淀：
   - **服务端 m4 的 V 做过 Nyquist 折叠**：m4 值域恰好 ±27（= 0.5° 短圈 Nyquist 27.23），而原始编码 `(code-129)/2` 覆盖约 ±64.5。不折叠时大量假速度超出 ±30 色标，表现为颜色混乱、相邻格跳变
   - 修复：`parseRstmVolume` 解码 V 后按该 cut 的 Nyquist 折叠到 `[-nyquist, nyquist)`：`(((v+n) % 2n)+2n)%2n - n`。W 实测值域 0~12 非负，无需折叠
   - **对比 m4 必须用同时次**：m4 是 03:17:55，最初误用 00:01:31 的 bz2 对比，得出"平均差 5.66 m/s"的错误结论；同时次下为：仅 m4 有值的点 0.2%、值分布各档占比差 <1%、中位差 1 m/s、平均差 2.57 m/s（差异来自网格半格偏移与邻域回找）
   - 我们有效点（23.9%）略多于 m4（16.4%）来自邻域回找；若要求严格一致可收紧回找范围
   - 9099 数据目录的 bz2 与 m4 时次对应关系：`Z_RADR_I_Z9517_20261018031755_...bin.bz2` ↔ `Z9517_20261018031755_UTC_*.m4`
   - 验证方式：`vue-tsc` 通过；同时次 m4 逐格点对比通过（上述口径）

【2026-10-21 本轮改动（V/W 空白问题：邻域回找 + 数据特性确认）】

1. 修改文件：`src/parse/cinradVolume.ts`、`CLAUDE.md`

2. 修改目的：用户反馈 V / W 比 Python 解析结果多出空白。经四轮诊断确认解析与 Python 完全一致，空白来自数据本身的缺测；同时增加邻域回找改善观感。

3. 关键规则沉淀（诊断结论，后续不要重复排查）：
   - **V/W 覆盖 46.2%，与 Python 完全一致**：我们 0.5° 层 152,717/330,280 = 46.2%；Python 逻辑独立解析 0.5° 短圈 154,156/333,960 = 46.2%。12 个抽样点逐点对比仅 1 处因“最近邻落到另一圈”有差异 → 解码公式 `(code-Offset)/Scale`、缺测规则 `code≤4`、Scale/Offset 读取位置全部正确
   - **空白是数据特性，不是 bug**：VCP21D 的 V/W 只在短距离圈（230km）采集（0.5°/1.5° 的长圈 460km 根本没有 V/W 矩），且远距离被雷达质量控制大量剔除 —— 实测 0.5° 短圈 100~230km 缺测 84%、6.0° 层 100km 外 100% 缺测。Python 解析同一文件同样得到这些 nan
   - **V/W 数组长度天然短于反射率**：0.5° 层 dBZ 1840 库（460km）/ V、W 920 库（230km）；`sampleRstmValue` 与 `volumeToGrid` 均按各字段自身长度寻址，远处越界即无数据
   - 观感改善：`volumeToGrid` 增加 `pickWithNeighbors` —— 缺测时在 ±2 个方位（同距离库）、±4 个库（本方位）范围内取最近有值。位移量不超过数据自身分辨率（0.98°/250m），整片无回波仍透明。回找后 0.5° 层 V 与 dBZ 的栅格填充率相当（35% vs 34%）
   - 若用户仍觉得空：优先怀疑对比的不是同时次同仰角（Python 端 matplotlib 常用 `cmap.set_bad()` 把 nan 画成背景色，看起来“没有空白”）

【2026-10-21 本轮改动（服务器产品目录同步为 8 个新产品）】

1. 修改文件：`public/data/products.json`

2. 修改目的：产品列表仍显示旧的 4 个产品（基本反射率/组合反射率/回波顶高/径向速度）——产品目录优先从服务器 `data/products.json` 读取，静态目录 `src/config/products.ts` 只是回退；上一轮只改了静态目录，所以界面不变。现已把服务器目录重写为与静态目录一致的 8 个产品。

3. 关键规则沉淀：
   - ★ 产品目录有两份，改动必须同步 ★：`public/data/products.json`（运行时优先读取）+ `src/config/products.ts`（服务器不可用时的回退）。只改一处会出现“代码改了界面不变”或“服务器挂了产品列表变样”
   - 8 个产品：dBZ(反射率，默认) / dBT(原始反射率) / V(径向速度) / W(谱宽) / ZDR(差分反射率) / CC(相关系数) / KDP(差分相移率) / SNRH(信噪比)
   - 已验证：JSON 合法、8 项、色标全部通过升序/首档透明/存在可见档/RGBA 0~255 校验（否则整表会被回退到静态目录）
   - 修改 `products.json` 后需硬刷新页面（该文件不带 hash，浏览器可能命中缓存）

【2026-10-21 本轮改动（重写为标准 CINRAD V2 格式 + 8 产品）】

1. 修改文件：`src/parse/cinradVolume.ts`（重写）、`src/types/index.ts`、`src/config/products.ts`（重写）、`src/components/RadarScreen.vue`、`src/api/radarApi.ts`、`AGENTS.md`

2. 修改目的：按用户提供的 Python 项目（Radar.DataService/radar/rio/STANDARD/structures.py）重写 RSTM 解析——原实现按“54 字段层 × 45 组 × 8 块”猜结构且反射率用固定公式（偏差约 13 dBZ），现改为标准格式逐径向逐矩解析，产品目录重写为 8 个矩字段产品。

3. 关键规则沉淀：
   - 标准格式布局：GENERIC(32)+SITE(128)+TASK(256)+CUT×N(256) → 径向[RADIAL_HEADER(64) + MOMENT_HEADER(32)+数据]×MomentNumber；实测 CutNumber=11（VCP21D，9 个唯一仰角，0.5/1.5° 分长短两圈）
   - 矩解码与 Python 完全一致：`value=(code-Offset)/Scale`，`code<=4 → 缺测`；Bin Length 1=8 位 / 2=16 位
   - 实测每径向 7 个矩：dBT(1,scale2/off66) / dBZ(2,2/66) / ZDR(7,16/130) / CC(9,200/5) / ΦDP(10,100/50,16位) / KDP(11,10/50) / SNRH(16,2/20)；V(3,2/129) 与 W(4,2/129) 只在短距离圈出现
   - ★ 时间基准是 Unix（1970），不是 Python 里的 1971 ★：实测 Seconds 与文件名时刻按 Unix 基准吻合，按 1971 算整体偏一年
   - ★ 长短圈合并：方位角量化到 1° + 逐字段取库数更多者 ★ —— 长圈反射率到 460km 但无 V/W，短圈有 V/W 只到 230km，整体替换会丢字段
   - 产品目录重写为 8 个（id 即字段名）：dBZ(默认)/dBT/V/W/ZDR/CC/KDP/SNRH，各配专用色标；ΦDP 解析但不作产品
   - `parseRstmVolume` 结构校验：Magic=RSTM、Major=2、CutNumber 1~32、库长合法，否则返回 null → 调用方回退合成网格（旧 demo 文件已实测回退正常）
   - 验证方式：`vue-tsc` 通过；真实 bz2 23 项断言全部通过（9 仰角/360 方位/每层库数 1840·1320·916·492/8 字段值域/时间 2026-10-18T00:01:47/栅格化 77,904 点 -10.5~51 dBZ/取样 8 字段/旧合成回退）

【2026-10-21 本轮改动（RSTM 基数据体接入：仰角层选择 + 栅格化渲染）】

1. 修改文件：`src/types/index.ts`、`src/parse/cinradVolume.ts`、`src/api/radarApi.ts`、`src/store/appStore.ts`、`src/components/RadarScreen.vue`、`src/styles.css`、`AGENTS.md`

2. 修改目的：把上一轮的 RSTM 体解析接入应用——当数据是基数据体（9 仰角层）时，屏头出现仰角选择器，切换仰角即时刷新画面；非基数据体（拼图 / m4 / 旧合成 RSTM）行为不变。

3. 关键规则沉淀：
   - 取数链路：`fetchRstmVolume(meta)`（LRU 3 条约 54MB + 在途合并）→ 成功则 `volumeToGrid(volume, elevationIndex, field)` 栅格化为 RadarGrid 走既有渲染/范围过滤/取值链路；返回 null（结构校验失败）则回退 `fetchRadarGrid` 合成网格，`setScreenElevations([])` 隐藏选择器
   - 字段选择：`RadarScreen.PRODUCT_FIELD` 按产品代码映射 RSTM 字段（Z/CR→z、V→v、W→w、ZDR→zdr、KDP→kdp、CC→cc，未列出回退 z），因为渲染链路一次只画一个数值场
   - 仰角切换是**纯局部操作**：复用组件内 `currentVolume` 重新栅格化 + 重建图层，不重新下载/解压（36MB + 1.5s 解压不能每次切换重来）
   - `RstmVolume.maxRanges`（层配置 +28）：超过该层最大探测距离的距离库是无效残留数据，栅格化与取样都必须忽略 —— 否则 19.5° 层会因远距离残留噪声把覆盖范围撑大 3 倍（实测 991×790 → 266×222）
   - `RstmRadial.fields` 改为 `Float32Array` + UNDEF 哨兵（原对象数组方案 448 万个 boxed number 超 100MB，必须用类型化数组）
   - 每屏独立 `elevations` + `elevationIndex`（store），`setLayout` 新屏不继承仰角（新数据需重新判定）；上传数据清空仰角维度
   - 验证方式：`vue-tsc` 通过；真实 bz2 端到端 17 项断言全部通过（临时脚本已删除）：9 层/缓存命中/0.5° 与 19.5° 栅格尺寸/Z 130,565 点 -14~68.5dBZ/V 96,886 点 ±14m/s/旧合成文件回退

【2026-10-20 本轮改动（RSTM 基数据体解析：9 仰角 × 6 字段）】

1. 修改文件：`src/parse/cinradVolume.ts`（新建）、`src/parse/cinradParser.ts`（导出 `tryParseHeader`）、`src/types/index.ts`、`AGENTS.md`

2. 修改目的：从 `*_SAD_CAP_FMT.bin(.bz2)` 中解析 9 个仰角层的径向数据，提取 Z / V / W / ZDR / KDP / CC，并支持按经纬度取样。

3. 关键规则沉淀（二进制布局对 9099 真实样本逆向得到）：
   - 文件头 128 字节 + 9 个仰角层配置（**项跨度不均：512 / 512 / 256×7**，仰角在项内 +128、库长 +20）+ 数据区（3256 起）
   - 数据区 = 54 个字段层（9 仰角 × 6 圈），每层 45 组；组 = 32 字节组头 + 8 个数据块；块 = 32 字节块头（+24 = 1840 表示 8 位 / 3680 表示 16 位）+ 1840 字节数据
   - 块步长 1872、组步长 15008、字段层步长 675360；每层 45 个方位，**方位角 = 组序号 × 8°**；库长 250m、8 位库数 1840、16 位（速度）库数 920
   - 只取第 1 圈（字段层 0~8）构建 9 层数据，6 圈是同一扫描的重复采样
   - 字段槽位与解码公式**待校准**（集中在 `FIELD_BLOCKS` 与各 `decodeXxx`，调整不影响寻址）：块0=Z、块1=W、块2=ZDR、块3=CC、块4=V(16 位)、块6=KDP
   - 极坐标换算必须用 **Haversine**：球面余弦定理在 dLon 很小时数值不稳定（实测把 100km 算成 0.1km）
   - 实测（Z9517 淮安，0.5° 层）：Z -14~68.5 dBZ（32,776 个有效点）、V -13.5~1.4 m/s、ZDR ±7.7 dB 均合理；W / CC / KDP 量级与标准气象值有偏差，需用已知回波校准编码公式
   - 下一步：UI 接入（仰角层选择器 + 点击地图弹窗展示 6 字段）+ 取数链路缓存 RstmVolume
   - 验证方式：`vue-tsc` 通过；真实数据 16 项断言全部通过（临时脚本已删除）

【2026-10-20 本轮改动（支持 .bz2 雷达基数据）】

1. 修改文件：`src/utils/bzip2.ts`（新建）、`src/types/seek-bzip.d.ts`（新建）、`src/types/index.ts`、`src/api/radarApi.ts`、`package.json`（新增 `seek-bzip`、`buffer`）、`AGENTS.md`

2. 修改目的：9099 数据目录中的 6 个 `.bin.bz2` 是雷达基数据的常见分发格式，之前被目录扫描跳过；现改为浏览器端解压后走同一解析链路。

3. 关键规则沉淀：
   - 新增 `utils/bzip2.ts`：seek-bzip 解压 + **注入全局 Buffer polyfill**（seek-bzip 是 Node 时代实现，内部用 `new Buffer()`；浏览器无该全局对象，必须在 decode 前注入）
   - 前端解压**禁止使用 compressjs**：它在浏览器会触发 amdefine 加载直接报错，只能用于 Node 脚本
   - 目录扫描不再跳过 bz2：`buildMetaFromFileName` 先剥掉 `.bz2` 判断内部格式，并打 `compressed` 标记
   - `loadGrid` 新流程：fetch → 校验 `BZh` 魔数 → 解压 → `detectFormat` 按二进制魔数（RSTM / SWAN / diamond 4）识别，不再依赖 `meta.format`
   - `detectFormat` 顺带修正了原 `guessFormat` 只看元数据的问题（清单缺字段或文件名不规范时按内容纠正）
   - 实测：6 个 bz2 均为 RSTM，解压 6.96MB → 36.5MB 约 1.5s；RSTM 体数据仍不可解码，解析结果为 400×400 合成网格（`isSynthetic=true`，界面显示“示意数据”）
   - 性能：解压同步阻塞主线程约 1.5s，靠 LRU 缓存每个文件只解压一次；首次播放各时次仍会卡顿，Worker 解压留作后续优化
   - 验证方式：`vue-tsc` 通过；`npm run build` 成功（主包 +40KB，来自 seek-bzip + buffer）；目录扫描 7 条、解压产物、魔数识别、完整解析、无全局 Buffer 时 polyfill 生效共 14 项断言通过（临时脚本已删除）

【2026-10-20 本轮改动（雷达数据源切换到 9099）】

1. 修改文件：`src/config/dataSource.ts`（新建）、`src/api/radarApi.ts`、`vite.config.ts`、`AGENTS.md`

2. 修改目的：雷达数据文件改为从 `http://localhost:9099/data/radarData/` 获取。该静态服务未返回 CORS 头，直接用绝对地址会被浏览器拦截，因此前端走同源路径 `/radar-data/`，由 Vite 代理转发。

3. 关键规则沉淀：
   - `DATA_BASE_URL = '/radar-data/'`；`vite.config.ts` 的 proxy 将 `/radar-data` 重写为 9099 的 `/data/radarData`
   - 清单获取顺序：配置显式地址 → 数据服务 `manifest.json` → **扫描目录索引**（nginx autoindex，解析 `<a href>`）→ 本地 `data/manifest.json`
   - 目录扫描只纳入 `.m4` / `.bin`；`.bz2` 跳过并汇总告警（浏览器无法解压，compressjs 仅 Node 可用）
   - `resolveDataUrl`：绝对/协议相对 URL 与含 `/` 的路径原样，纯文件名拼 `DATA_BASE_URL`
   - 实测 9099 目录：6 个 `.bz2` + 1 个 `.m4` → 清单 1 条；m4 为 990×828（819,720 点），解析约 190ms，缺测 765,691 点
   - 生产部署需 nginx 配置同样的 `/radar-data/` 反向代理；产品目录/应用配置仍走本地 `data/`
   - 验证方式：`vue-tsc` 通过；经 Vite 代理的真实数据端到端断言全部通过（临时脚本已删除）

【2026-10-20 本轮改动（项目整理：文档同步 + 样式去重）】

1. 修改文件：`CLAUDE.md`、`docs/PRODUCT_GUIDE.md`、`src/styles.css`

2. 修改目的：让文档与当前实现一致（渲染签名、副本过滤、色标范围、底图），合并时间轴区域的重复 CSS 声明。

3. 关键规则沉淀：
   - `PRODUCT_GUIDE.md` 同步 `renderRadar(..., smooth, range)`、`updateRadarProduct/updateRadarRange/updateRadarSmooth`、`sampleGridValue(..., minVisible, range)`；新增“运行时色标显示范围”小节；最小示例改用 `applyBaseMap`
   - 文档明确：渲染在**数据副本**上过滤，`grid.data` 不被修改；`fetchRadarGrid` 返回的网格可能被多屏共享，必须只读
   - `styles.css` 合并 `.timeline-pick-label` / `.timeline-time` / `.timeline-count` 的重复声明（原各定义两次）
   - CLAUDE.md 项目基础信息补充 `mapBorder/` 与 `utils/`；“遗留问题”移除已过期的“未做浏览器验证”条目
   - 死代码/冗余仅记录不删除（项目规则）：`Timeline.vue` 的 `defineExpose({ step })`、`radarApi.guessFormat` 死分支、`ProductList.vue` 自赋值、仅内部使用的导出（`TIANDITU_KEY` / `addTiandituBase` / `M4_UNDEF_RAW`）
   - `dist/` 构建产物清理未执行（等待授权），已被 `.gitignore` 忽略，不影响仓库
   - 验证方式：`npx vue-tsc --noEmit` 通过

【2026-10-19 本轮改动（数据加载后自动定位地图）】

1. 修改文件：`src/components/RadarScreen.vue`、`AGENTS.md`

2. 修改目的：地图默认固定视野与数据位置不一致（如滨州单站数据落在视野外），希望加载后自动定位到数据范围。

3. 关键规则沉淀：
   - `fitToGrid(grid)`：由 `xStart/yStart/xDelta/yDelta/xSize/ySize` 计算 `LatLngBounds`，调用 `fitBounds({ padding: [24,24], animate: false })`
   - **仅在数据范围变化时定位**：`fittedBounds.equals(bounds, 1e-6)` 相同则跳过，避免同一区域切时次/切产品时重置用户手动缩放的位置
   - 首次加载、上传新文件、清单模式切到不同站点（区域变化）都会自动定位
   - `yDelta` 可能为负，构造 bounds 必须用 `Math.min/max` 归一
   - 验证方式：`vue-tsc` 通过；浏览器待手工确认（打开即对准数据；切时次视野不动；上传异区域文件后自动跳转）

【2026-10-19 本轮改动（修复切屏后雷达图层不显示）】

1. 修改文件：`src/components/RadarScreen.vue`

2. 修改目的：6 屏 ↔ 1 屏切换后，复用屏（第 1 屏）的雷达色斑消失，必须拖动/缩放地图才出现。

3. 原因与修复：
   - 根因：上一轮只加了 `invalidateSize`。它会触发 QE 的 canvas resize 并重建 framebuffer，但 GL 图层没有持续渲染循环，resize 后不会自动重绘 → 图层被清空后一直空白（与 P1 的 `forceRedraw` 同源）
   - 修复：resize 回调中在 `invalidateSize` 之后调用 `layer.reinit()`（QE 公开 API：setupGL + 立即 _redraw）
   - 新建屏不受影响：挂载时容器尺寸已确定，renderRadar 直接按正确尺寸绘制
   - ★ 规则：任何导致地图容器尺寸变化的操作（切布局、窗口缩放）都必须 “invalidateSize + 图层 reinit” 成对出现 ★
   - 验证方式：`vue-tsc` 通过；浏览器待手工确认（1 ↔ 6 屏来回切换后色斑应立即显示）

【2026-10-19 本轮改动（修复分屏后雷达色斑位置偏移）】

1. 修改文件：`src/components/RadarScreen.vue`

2. 修改目的：1 屏切到 6 屏后，各屏雷达色斑不在正确地理位置（第 1/2 屏偏出视野，其余屏偏右下），缩放或拖动地图后才回正。

3. 原因与修复：
   - 根因：布局切换导致地图容器宽高变化，但没有调用 `map.invalidateSize()`。Leaflet 与 QE 的 GL 图层仍按旧容器尺寸生成投影与纹理，色斑被画到错误位置；地图交互会触发重新量算，所以表现为“缩放/拖动后回正”
   - 修复：`RadarScreen` 用 `ResizeObserver` 监听 `.map` 容器，rAF 合并后调用 `invalidateSize({ animate: false })`；容器尺寸为 0（被隐藏）时跳过
   - 卸载时取消待执行 rAF 并 disconnect，避免销毁后操作地图
   - 与图例外挂 ResizeObserver 同源：复用组件在布局变化后必须重新量算自身尺寸
   - 验证方式：`vue-tsc` 通过；浏览器待手工确认（1 屏切 6 屏后各屏色斑应立即位于正确地理位置）

【2026-10-19 本轮改动（修复重置按钮 + 加宽图例）】

1. 修改文件：`src/components/Legend.vue`、`src/styles.css`

2. 修改目的：点击“重置”无反应；色标条偏窄，档位与手柄不易分辨。

3. 关键规则沉淀：
   - ★ 浮层内的按钮必须 `@pointerdown.stop` ★ 图例根元素在 pointerdown 时 `setPointerCapture` 开始拖拽，指针被根元素捕获后按钮收不到 click（只写 `@click.stop` 不够），表现为“点重置没反应”
   - `.legend-bar` 宽度 176px → 220px；手柄位置按百分比、刻度/文本按 flex 自适应，无需其他改动
   - 验证方式：`vue-tsc` 通过；浏览器待手工确认（点重置后两个手柄回到两端、全部色块恢复、地图显示全范围）

【2026-10-19 本轮改动（修复分屏首屏色标消失）】

1. 修改文件：`src/components/Legend.vue`、`src/styles.css`

2. 修改目的：4 屏布局下第 1 屏的色标图例消失（只在底边露出一条背景）。

3. 原因与修复：
   - 根因：图例位置 `pos` 是组件内部状态。布局 1 屏 → 4 屏时，第 1 屏组件被复用，旧位置超出变矮后的地图区域，被 `.radar-screen` 的 `overflow: hidden` 裁掉；新增屏是新组件（pos=null）不受影响，所以只有被复用的屏“缺失色标”
   - 修复：`Legend` 用 `ResizeObserver` 监听地图容器尺寸，变化时把已拖动的图例钳制回可见范围（布局切换、窗口缩放都覆盖）
   - `.legend-float` 的 `z-index` 由 900 提升到 1200，避免被 QE 的 GL 画布层遮挡
   - 验证方式：`vue-tsc` 通过；浏览器待手工确认（1 屏拖动图例 → 切 4 屏，第 1 屏图例应自动回到可见区域）

【2026-10-19 本轮改动（范围手柄鼠标样式）】

1. 修改文件：`src/styles.css`

2. 修改目的：范围手柄 hover / 按下时统一显示“小手”（`cursor: pointer`），替换原来的左右缩放箭头（`ew-resize`）。

3. 关键规则沉淀：
   - 图例内可点击/可拖动元素统一用 `pointer`；`ew-resize` 仅适合表达“可横向调节”但不符合本平台交互习惯
   - `.legend-float` 根元素的 `cursor: grab` 会被子元素 `.legend-handle` 的 `pointer` 覆盖，无需额外处理

【2026-10-19 本轮改动（地图底图切换：行政 / 国界）】

1. 修改文件：`src/types/index.ts`、`src/store/appStore.ts`、`src/render/mapManager.ts`、`src/components/Toolbar.vue`、`src/components/RadarScreen.vue`、`AGENTS.md`

2. 修改目的：新增底图切换——"行政"保持天地图；"国界"用 `src/mapBorder` 的三份 GeoJSON 绘制矢量底图（陆地 `#efefdb`、海洋 `#97b6e1`、界线 `#606266`；世界/中国国界 1px、省界 0.8px）。

3. 关键规则沉淀：
   - `BaseMapMode` 全局状态在 store（`baseMap`），图层切换行为在 mapManager（`applyBaseMap` / `applyBaseMapToAll`），沿用“状态在 store、行为在 mapManager”约定
   - 国界模式海洋色用地图容器内联背景承载（无接缝）；世界/中国多边形填充陆地色；省界 `fill: false` 只描边
   - 矢量底图放 `qe-base-border` pane（zIndex 190），保证在瓦片（200）与雷达图层之下
   - 三份 GeoJSON 用 `?url` 引入：首次切到国界才加载并缓存 Promise；构建产出独立 assets（444KB / 530KB / 3016KB），不进主包
   - 每张地图独立切换 token：异步回来时若已切走或已卸载则丢弃；`unregisterMapLink` 同时清理底图登记（Map 持有地图引用会导致无法 GC）
   - `createRadarMap` 开启 `preferCanvas`（省界 7.5 万点，SVG 渲染会卡）
   - 验证方式：`vue-tsc` 通过；`npm run build` 成功，三个 JSON 作为独立资源输出

【2026-10-19 本轮改动（范围手柄改为自绘，彻底解决叠加偏移）】

1. 修改文件：`src/components/Legend.vue`、`src/styles.css`、`AGENTS.md`

2. 修改目的：el-slider 叠加到色标条上时，其内部 `height` / `runway margin` / `button-wrapper top` 随 Element Plus 版本变化，多次覆盖后仍出现手柄跑到色标条外的固定偏移。改为自绘双圆点手柄，定位只由本项目 CSS 决定。

3. 关键规则沉淀：
   - 手柄 `.legend-handle`：`top:50%`（26px 色标区中心 = 13px = 色标条中线）+ `translate(-50%,-50%)`；水平位置按 `(idx+0.5)/n` 对准色块中心
   - 拖动逻辑：`pointerdown` 记录朝向并 `setPointerCapture`；`pointermove` 按 `.legend-range` 宽度换算档位（钳制在另一手柄内侧）；**松手才写 store**，避免拖动中反复重建数据源
   - 不再 import `ElSlider`，`sliderValue` / `watch` 同步逻辑一并删除
   - `.legend-range` 保持 `pointer-events:none`，仅手柄 `auto`：色标条空白处仍可拖动图例浮层
   - ★ 教训：第三方组件内部布局不能作为像素级对齐基准，需要精确叠加时优先自绘 ★

【2026-10-19 本轮改动（修正范围滑块叠加定位）】

1. 修改文件：`src/styles.css`

2. 修改目的：上一轮把 el-slider 高度压到 10px 并清零 runway margin，实际渲染时手柄/轨道偏离色标条（跑到色标块外）。改为“只做整体居中、不碰组件内部尺寸”的稳定方案。

3. 关键规则沉淀：
   - 叠加层 `.legend-range` 用 `top:0; bottom:0` 覆盖整个色标区（含 8px 上下留白），内部 `el-slider` 用 `top:50% + translateY(-50%)` 整体居中 → 手柄中心 = 色标条中线，与 Element Plus 内部高度/margin 的版本差异解耦
   - ★ 禁止覆盖 `.el-slider` 的 `height` 与 `.el-slider__runway` 的 `margin` ★ 这两个值随版本变化，覆盖后会产生固定偏移；只允许覆盖 `--el-slider-height`（轨道粗细）
   - 容器 `pointer-events: none` + 滑块 `pointer-events: auto`：色标条空白处不拦截图例拖拽；`@pointerdown.stop` 在冒泡阶段仍然生效
   - 手柄白色描边（含 `:hover` / `.dragging`）保持不变

【2026-10-19 本轮改动（范围滑块垂直居中 + 白色描边）】

1. 修改文件：`src/styles.css`

2. 修改目的：让两个手柄的中心严格落在色标条垂直中线上；手柄描边改为白色。

3. 关键规则沉淀：
   - 叠加容器的绝对定位尺寸必须与色标条等高（10px），配合 `top: 50% + translateY(-50%)` 才能精确对齐；若按 el-slider 默认高度（26/32px）计算，会因内部 runway margin 产生上下偏移
   - el-slider 需同时覆盖 `height` 与 `__runway` 的 `margin`，并用 flex `align-items: center` 居中，摆脱 Element Plus 默认的垂直布局
   - 手柄 `border: 2px solid #fff`，并一并覆盖 `:hover` / `.dragging`，否则交互时会回弹成主题蓝描边
   - 手柄 18px 点击区允许溢出 10px 容器：父级（`.legend-range` / `.legend-bar-wrap`）不得设置 `overflow: hidden`

【2026-10-19 本轮改动（范围滑块叠加到色标条）】

1. 修改文件：`src/components/Legend.vue`、`src/styles.css`

2. 修改目的：按 UI 要求把范围双滑块从色标条下方移到色标条上叠加显示，减少图例高度。

3. 关键规则沉淀：
   - 结构改为 `.legend-bar-wrap`（相对定位 + 上下 8px 留白）同时包住 `.legend-bar` 与绝对定位的 `.legend-range`，滑块垂直居中压在色标条上
   - 滑块轨道 `background: transparent` 露出色标颜色；已选区间用半透明白色（rgba 255/255/255/0.22）；手柄深底 + 亮蓝描边，保证在彩色色标上可辨认
   - el-slider 压缩为 `height: 26px`、`--el-slider-height: 10px`、runway `margin: 8px 0`（8+10+8=26），与 10px 色标条精确垂直居中
   - 范围文本与「重置」移到色标与刻度下方（`.legend-range-info`），不再占用色标条区域
   - 滑块容器必须保留 `@pointerdown.stop`，否则拖动滑块会带动整个图例浮层

【2026-10-19 本轮改动（修复范围滑块拖动后地图不刷新）】

1. 修改文件：`src/render/radarRenderer.ts`、`src/components/RadarScreen.vue`、`AGENTS.md`

2. 修改目的：拖动图例范围滑块松手后，数据源已按新范围重建，但地图画面不更新，必须缩放或拖动地图才刷新。

3. 原因与修复：
   - 根因：QE 的 GL 图层**没有持续渲染循环**，`setDataSource` / `setDrawOptions` 只替换数据与样式，不保证立即绘制；测绘帧调度不可用时表现为“数据已换、画面还是旧的”
   - 修复：新增内部 `forceRedraw(layer)`，调用 QE 公开 API `reinit()`（内部 `setupGL()` + 直接 `_redraw()`），在 `updateRadarProduct` / `updateRadarRange` / `updateRadarSmooth` 三处更新后调用
   - 影响面：不仅范围滑块，切换产品与平滑也走同一路径，一并获得即时刷新
   - `renderRadar` 新建图层不调用（`addLayer` 本身触发绘制）
   - `reinit()` 会重建 GL 资源，只允许用于低频交互（切产品 / 切平滑 / 范围松手）；**禁止放进播放循环**
   - 验证方式：`npx vue-tsc --noEmit` 通过；浏览器待手工确认（松手后色斑立即变化、点击范围外无弹窗）

【2026-10-19 本轮改动（取消单幅网格点数上限）】

1. 修改文件：`src/constants.ts`、`src/parse/mosaicParser.ts`、`src/parse/micapsM4Parser.ts`、`AGENTS.md`

2. 修改目的：按需求取消 P3 引入的 400 万点单幅网格上限（`MAX_GRID_POINTS`），解析器不再因头部声明的格点数拒绝文件。

3. 关键规则沉淀：
   - `MAX_GRID_POINTS` 常量与 mosaic/m4 两处校验块已删除，`constants.ts` 只保留 `UNDEF`
   - 取消后超大网格仅由原有校验兜底：mosaic 检查“数据区不足”、m4 检查“数据 token 不足”；损坏文件若数据区确实足够大，会按声明分配大数组（原限制的初衷，当前接受该风险）
   - 上传文件 200MB 上限、fetch 10s 超时、产品色标校验保持不变
   - 若未来需要恢复限制，应在解析器分配数组之前校验，并同步更新 AGENTS.md 第 6 节第 14 条

【2026-10-19 本轮改动（色标范围选择功能）】

1. 修改文件：`src/types/index.ts`、`src/utils/range.ts`（新建）、`src/store/appStore.ts`、`src/render/radarRenderer.ts`、`src/components/Legend.vue`、`src/components/RadarScreen.vue`、`src/styles.css`、`AGENTS.md`

2. 修改目的：图例增加每屏独立的色标数值范围选择（双滑块）：只把选中区间的颜色画到地图上，范围外格点透明；点击取值范围外同样返回空，保证“图上有色 = 点击有值”。

3. 关键规则沉淀：
   - `ValueRange` 语义左闭右开 `[min, max)`；上界取“结束档的下一档值”（选 20~50 档 → max=55），与色标分档 `[v_i, v_{i+1})` 一致
   - 换算集中在 `utils/range.ts`（`isValueInRange` / `isValueVisible` / `rangeFromStopIndex` / `stopIndexFromRange`），渲染层与图例共用，禁止各写一份
   - `ScreenState.valueRange` 每屏独立；`setLayout` 新屏继承并复制对象；范围变化走 `updateRadarRange` 重建数据源（放宽范围必须从原始网格重新过滤，与阈值变化同理）
   - 图层判重键加入 `valueRangeKey`；上传数据同样应用本屏范围
   - 图例滑块必须用本地 ref + watch 同步（Element Plus 受控踩坑，同 Timeline 的 date-picker）；滑块容器 `@pointerdown.stop` 防止拖动滑块带动整个浮层
   - 验证方式：`npx vue-tsc --noEmit` 通过；范围语义、14 档全部索引组合往返、每屏状态隔离共 30 项断言通过（临时脚本已删除）

【2026-10-19 本轮改动（P3：输入边界与失败反馈）】

1. 修改文件：`src/utils/http.ts`（新建）、`src/constants.ts`、`src/api/radarApi.ts`、`src/api/configApi.ts`、`src/api/productApi.ts`、`src/parse/mosaicParser.ts`、`src/parse/micapsM4Parser.ts`、`src/store/appStore.ts`、`src/App.vue`、`AGENTS.md`

2. 修改目的：把“会永久挂起 / 会 OOM / 会静默使用非法配置 / 失败无反馈”的边界情况全部收口。

3. 关键规则沉淀：
   - 所有 fetch 统一走 `utils/http.ts` 的 `fetchWithTimeout`（默认 10s），超时抛 `FetchTimeoutError`；覆盖产品目录、应用配置、文件清单、雷达文件四处
   - 上传文件 > 200MB 直接拒绝（`arrayBuffer()` 全量入内存）；单幅网格 > 400 万点由 mosaic/m4 解析器在分配数组前拒绝（`MAX_GRID_POINTS`）
   - 服务器产品色标校验加严：value 必须 `Number.isFinite` 且严格升序、RGBA 必须 0~255、至少一个 alpha>0 档，否则整表回退静态目录；首档不透明只 `console.warn`（渲染层弱值过滤仍兜底）
   - `getProductByIdSafe` 在产品目录未加载时回退静态目录，**禁止返回 `colorStops: []` 占位**（空数组会让色例终止档号为 -1，QE 可能抛错）
   - 应用初始化失败必须 `ElMessage.error` 给出可见反馈，不能只 `console.error`
   - 验证方式：`npx vue-tsc --noEmit` 通过；超时、6 组色标校验、M4/拼图超限、上传超限、产品兜底共 19 项断言全部通过（临时脚本已删除）

【2026-10-19 本轮改动（P1：播放 / 多屏性能）】

1. 修改文件：`src/types/index.ts`、`src/parse/mosaicParser.ts`、`src/parse/micapsM4Parser.ts`、`src/parse/cinradParser.ts`、`src/render/radarRenderer.ts`、`src/render/mapManager.ts`、`src/api/radarApi.ts`、`src/api/configApi.ts`、`src/App.vue`、`src/components/TimeAxis.vue`、`AGENTS.md`

2. 修改目的：解决播放/多屏场景的重复下载与主线程解析压力、网格内存占用、时间轴与地图联动的逐事件重绘，以及时间轴档数无上限的隐患。

3. 关键规则沉淀：
   - `RadarGrid.data` 改为 `Float32Array`（168 万点约 13.4MB → 6.7MB），三个解析器与渲染副本同步适配；Float32 可精确表示哨兵 999999（< 2^24）
   - `fetchRadarGrid` 内置 LRU（12 条，键 = `binFile|productId`）+ 在途 Promise 合并：同一时次只下载解析一次，多屏同步共享同一 grid 对象 → **调用方必须只读**
   - `buildTimelineTimes` 增加时次上限 3000：超限按整分钟放大间隔并 `console.warn`；默认 6 分钟 × 10 天 = 2401 档，行为不变
   - App 播放推进前检查各屏 status，任一屏"加载中…"则跳过本次推进，避免请求/解析堆积；本轮未引入 Worker（缓存命中后解析不再是瓶颈）
   - 地图联动 move 事件改 rAF 合并（每帧最多一次 setView）；**onMove 必须先判 syncing**，否则程序化 setView 会形成 A→B→A 的帧循环
   - TimeAxis 重绘改 rAF 合并；timesMs/marksMs 升序排序，marks 用 lowerBound 二分只画可见区间；卸载时取消待执行帧
   - 验证方式：`npx vue-tsc --noEmit` 通过；LRU 命中/并发合并/产品隔离/淘汰重载/Float32Array/拼图尺寸/时次上限共 20 项断言全部通过（临时脚本已删除）

【2026-10-19 本轮改动（P2：抽出公共模块 + 统一屏 id 语义）】

1. 修改文件：`src/utils/datetime.ts`（新建）、`src/constants.ts`（新建）、`src/api/configApi.ts`、`src/api/radarApi.ts`、`src/components/TimeAxis.vue`、`src/components/Timeline.vue`、`src/components/ProductList.vue`、`src/components/RadarScreen.vue`、`src/App.vue`、`src/store/appStore.ts`、`src/parse/mosaicParser.ts`、`src/parse/micapsM4Parser.ts`、`src/parse/cinradParser.ts`、`src/types/index.ts`、`AGENTS.md`

2. 修改目的：收敛四处重复的时间格式实现与三处重复的缺测哨兵常量；把“屏 id”与数组下标解耦；修正端口 5173/5179 与 `listRadarFiles` 的文档漂移。

3. 关键规则沉淀：
   - 时间格式统一走 `src/utils/datetime.ts`（msToISO/msToText/isoToMs/isoToCompact/compact12ToISO/digits14ToISO），业务文件禁止再自写格式化；已验证输出与旧实现逐字节一致
   - 缺测哨兵统一用 `src/constants.ts` 的 `UNDEF`；解析器只保留“文件内缺测表示”（M4_UNDEF_RAW=9999、mosaic rawUndef=255/9999）
   - 屏 id 是稳定标识：store 所有 mutation 走 `findScreen(id)`，`setLayout` 新屏 id 取“当前最大 id + 1”；组件禁止再用 `screens[screenId]` 下标访问
   - 产品查找双入口分工固定，不合并（避免 store 反向依赖 api）：`productApi.findProduct` 允许 undefined（解析层用）、`appStore.getProductByIdSafe` 永不 undefined（UI 用）
   - 端口以 `package.json` 为准：5179（CLAUDE.md / AGENTS.md 已同步）
   - 验证方式：`npx vue-tsc --noEmit` 通过；datetime 等价性、store id 语义两组临时断言脚本全部通过（脚本已删除）

【2026-10-19 本轮改动（P0 修复：数据正确性 + 取数竞态）】

1. 修改文件：`src/parse/cinradParser.ts`、`src/render/radarRenderer.ts`、`src/components/RadarScreen.vue`、`AGENTS.md`

2. 修改目的：修复审查确认的 5 个 P0 问题（缺测哨兵被覆盖、合成数据未标注、渲染就地改数据不可逆、取数竞态、无数据时旧图层残留），并统一取值阈值口径。`npx vue-tsc --noEmit` 通过。

3. 关键规则沉淀：
   - `parseRSTM` 不再读取头部偏移 96 的缺测值（实测 -999999），也不再覆盖 `grid.undef`；合成网格哨兵恒为 `SYNTH_UNDEF(999999)`。否则范围外 999999 会被当成有效值渲染成最高档淡紫色
   - `parseRSTM` 恒返回 `isSynthetic=true`（体数据是合成高斯团块，头部只提供站点定位），UI 据此显示"示意数据"
   - `renderRadar` / `updateRadarProduct` 一律在副本上过滤弱值（`buildDisplayValues`），`grid.data` 永远保持原始值；阈值变化必须 `setDataSource` 重建数据源（变高补抹、变低恢复），阈值相同只 `setDrawOptions`
   - `sampleGridValue` 新增第 4 参 `minVisible`：点击取值必须传 `firstVisibleThreshold(product)`，与渲染的透明口径一致
   - `RadarScreen` 新增 `refreshToken` 请求序号：`refresh`/上传入口自增，每个 `await` 之后校验 `token === refreshToken`，过期响应与过期错误一律丢弃；`onBeforeUnmount` 自增以作废在途请求
   - 无文件 / 加载失败必须 `clearLayer()`（移除图层 + 清 `layerGrid`），不得只改状态文本，否则屏上残留旧时次画面且点击返回旧值
   - ★ 旧结论作废（2026-08-24 条目"renderRadar 就地修改 grid.data…取值天然与显示一致"已失效，以本条为准）
   - ★ 待验证：`sampleGridValue` 与 QE bitmap 渲染的半格偏移仍需真实数据比对，确认前禁止加 0.5 偏移

【2026-10-19 本轮改动（代码库全面审查）】

1. 修改文件：`CLAUDE.md`（仅文档记录，未改动业务代码）

2. 修改目的：对代码库做全维度审查（代码结构 / 性能 / 可维护性 / 重复逻辑 / 错误处理 / 安全 / 依赖 / 测试 / 构建部署），结论与分级优化清单见"待办事项清单"。

3. 关键规则沉淀（审查确认的高危事实，后续改动必须遵守）：
   - ★ `parseRSTM` 用文件头 undef（实测 -999999）覆盖了合成网格的 999999 哨兵，导致合成区"缺测"被当作有效值渲染成最高档色斑（`src/parse/cinradParser.ts` 末尾）
   - ★ RSTM 体数据实际是合成高斯团块，却置 `isSynthetic=false`，UI 不提示"示意数据"，业务上属假数据未标注
   - ★ 渲染层就地过滤弱值不可逆：产品由低阈值切回高阈值后，弱值已永久写成缺测（`src/render/radarRenderer.ts` maskBelowThreshold / updateRadarProduct）
   - ★ `RadarScreen.refresh` 无请求序号/取消机制：快速切时次或播放时，先发后至的旧响应会覆盖新时次
   - ★ 找不到文件或加载失败时未移除旧图层与 `layerGrid`：屏上仍显示上一时次色斑图，点击取值也返回旧值
   - 时间格式化（ISO / 紧凑 14 位串）在 configApi、radarApi、TimeAxis、Timeline 各写一份；缺测哨兵 999999 在三个解析器各定义一次 —— 后续统一抽公共模块，禁止再各写一份

【2026-08-25 本轮改动（每屏独立文件上传）】

1. 修改文件：`src/api/radarApi.ts`、`src/components/RadarScreen.vue`、`src/styles.css`、`AGENTS.md`

2. 修改目的：每屏屏头新增独立"上传"按钮——上传本地雷达数据文件后按预设格式识别（MICAPS m4 "diamond 4" → SWAN 拼图 "diamond" → RSTM 魔数 "RSTM"，按序判定），识别成功在本屏渲染并 ElMessage 提示，格式不符提示"文件格式不符"。

3. 关键规则沉淀：
   - parseUploadedFile(file, productId)：时刻优先取文件名 14 位串、否则文件修改时间；m4 判定必须在 mosaic 之前（两者头部同以 "diamond" 开头）；.bz2 不支持（compressjs 仅 Node），accept 限 .bin/.m4
   - 上传数据记为当前时次视图（layerTime=sc.time）：切产品/平滑走局部刷新，切时次恢复时间轴数据
   - input.value='' 重置以允许重复上传同一文件；ElMessage 提示 + 屏状态栏"上传数据/文件格式不符"

【2026-08-25 本轮改动（日期面板无法选择修复）】

1. 修改文件：`src/components/Timeline.vue`

2. 修改目的：修复 el-date-picker 面板点击日期无响应——原用只读 :model-value + @change 受控绑定，面板内部状态被未更新的 prop 重置。改为标准 v-model + 本地 ref（jumpValue/anchorValue），外部时刻变化经 watch 同步进 ref。

3. 关键规则沉淀：
   - ★ Element Plus 表单类控件（date-picker/select 等）禁止只读 :model-value 受控：面板交互依赖 update:model-value 回流，必须 v-model（本地 ref）+ watch 同步外部状态 + @change 应用业务
   - ref 同步源：jumpValue ← activeScreen.time；anchorValue ← timelineConfig.mode + timelineTimes（预报首时次/实况末时次）

【2026-08-25 本轮改动（时间控件宽度 + 无数据提示）】

1. 修改文件：`src/components/Timeline.vue`、`src/components/RadarScreen.vue`、`src/styles.css`、`src/api/radarApi.ts`（注释）、`AGENTS.md`

2. 修改目的：时间选择控件宽度 175→160px（去掉多余留白）；选择时刻不再吸附最近时次，直接按所选时间取文件，清单找不到/模板 404 统一提示"该时次无数据"（原"该时次无文件"）。

3. 关键规则沉淀：
   - 时间选择控件跳转不吸附：用户选什么时间就查什么时间，文件不存在由 RadarScreen 状态栏提示"该时次无数据"（清单 missing / 模板 RadarFileMissingError 两路径不变，仅措辞调整）
   - 刻度轴拖拽的吸附行为保持不变（仅时间控件取消吸附）

【2026-08-25 本轮改动（时次下拉框改时间选择控件）】

1. 修改文件：`src/components/Timeline.vue`、`src/styles.css`、`AGENTS.md`

2. 修改目的：时次下拉框（el-select）改为 el-date-picker 时间选择控件——显示 YYYY-MM-DD HH:mm、value YYYYMMDDHHmm，所选时刻二分吸附最近可用时次后跳转；删除 timeOptions 选项列表与 ElSelect/ElOption 导入，样式类 .timeline-select → .timeline-jump。

3. 关键规则沉淀：
   - 离散时次场景下 el-date-picker 任意时刻输入需吸附最近可用时次（与 TimeAxis 画布行为一致），二分查找 times 数组
   - :model-value + @change 受控用法（非 v-model），value-format="YYYYMMDDHHmm" 紧凑串直接作为控件值

【2026-08-25 本轮改动（锚点时间控件 value 格式统一）】

1. 修改文件：`src/components/Timeline.vue`

2. 修改目的：锚点时间控件（el-date-picker，配置模式）与时次下拉框统一规格——显示格式 YYYY-MM-DD HH:mm（format），value 为紧凑串 YYYYMMDDHHmm（value-format）；onPickAnchor/pickValue 按紧凑串换算 ISO。

3. 关键规则沉淀：el-date-picker 的 value-format="YYYYMMDDHHmm" 可直接解析紧凑串（dayjs 分段解析）；两个时间控件 value 格式统一后换算逻辑可复用（slice 定位拼接 ISO，秒固定 00）。

【2026-08-25 本轮改动（悬停提示到分钟）】

1. 修改文件：`src/components/TimeAxis.vue`

2. 修改目的：鼠标滑动悬停提示时间格式改为 YYYY-MM-DD HH:mm（fmtMin）；选中时刻的指示线文字保持 YYYY-MM-DD HH:mm:ss（fmtFull）不变。

3. 关键规则沉淀：悬停提示与选中时刻文字用两个格式函数区分（fmtMin/fmtFull），避免一刀切修改被整体撤回。

【2026-08-25 本轮改动（撤回提示到分钟）】

1. 修改文件：`src/components/TimeAxis.vue`、`src/components/Timeline.vue`

2. 修改目的：按用户要求撤回上一轮"提示到分钟"修改——画布悬停/选中时刻文字恢复为 YYYY-MM-DD HH:mm:ss（fmtFull），右侧当前时间恢复 MM-DD HH:mm:ss。

3. 关键规则沉淀：撤回修改用编辑工具精确回退对应代码，不用 git checkout（会连带丢掉其他未提交改动）。

【2026-08-25 本轮改动（时间轴提示到分钟）】

1. 修改文件：`src/components/TimeAxis.vue`、`src/components/Timeline.vue`

2. 修改目的：时间轴提示文字去掉秒——画布悬停时间与选中时刻文字改为 YYYY-MM-DD HH:mm（fmtMin），右侧当前时间文字改为 MM-DD HH:mm（slice(5,16)）。

3. 关键规则沉淀：时间显示类格式统一到分钟；fmtISO 为唯一 ISO 生成源，画布文字用 fmtMin 截取。

【2026-08-25 本轮改动（拖动后视图不回弹修复）】

1. 修改文件：`src/components/TimeAxis.vue`

2. 修改目的：修复"不能向左移动/拖动没生效"——原实现在松手后 viewMs=null 使视图弹回选中时次，时次稀疏时吸附结果仍是原时次，拖动净效果为零。

3. 关键规则沉淀：
   - 松手后视图停在拖动位置（viewMs 持久化，不再重置）；选中时刻的绿色指示线画在 xFor(currentMs)（随视图滑动，可能偏离中心）
   - emitGuard + nextTick 区分"画布内部选时"（视图不动）与"外部跳转"（视图重新居中）；guard 在 nextTick 清除，watch 先于 nextTick 执行保证顺序
   - pointerdown 锚点必须取视图中心 viewMs ?? currentMs（两者可能不重合，否则拖拽起步视图跳变）
   - 时间轴/标记重建（times 变化）时 viewMs 重置重新居中

【2026-08-25 本轮改动（时间轴拖动松手后取文件）】

1. 修改文件：`src/components/TimeAxis.vue`、`AGENTS.md`

2. 修改目的：时间轴拖拽改为"拖动中仅自由平移视图（不吸附、不触发取文件），松手后吸附最近时次并 emit 加载对应时间的文件"，避免拖动过程中连续触发取数。

3. 关键规则沉淀：
   - pointermove 拖拽分支只更新 viewMs 并置 dragMoved=true，不再 emit
   - pointerup 统一处理：dragMoved=true → 吸附视图中心最近时次 emit；否则按点击处理（吸附点击位置最近时次）；最后 viewMs=null 回归受控
   - emit 后父组件 setScreenTime → RadarScreen 查文件（无文件提示"该时次无文件"），链路不变

【2026-08-25 本轮改动（按钮与时间条对齐）】

1. 修改文件：`src/styles.css`

2. 修改目的：时间轴 ◀▶ 按钮与画布顶部时间条（20px 刻度条）对齐——.timeline 改为 align-items: flex-start，按钮高度 20px、Element Plus 控件 --el-component-size: 20px、文字行高 20px，整行控件与时间条顶对齐且等高。

3. 关键规则沉淀：
   - 同一属性的多处声明以后者为准，调整尺寸时先清理旧覆盖（本次删除了遗留的 28px 规则，统一为 20px）
   - 时间条基准高度 = TimeAxis 画布顶部 scaleBar 的 20px，控件行全部按此基准对齐

【2026-08-25 本轮改动（时间轴边缘刻度裁切修复）】

1. 修改文件：`src/components/TimeAxis.vue`

2. 修改目的：修复时间轴两端刻度文字被裁切（左侧"00"贴边、右侧"12:"截断），视觉上像与左右按钮没对齐。

3. 关键规则沉淀：
   - 画布增加左右内边距 PAD_X=10：时间跨度映射到 [PAD_X, width-PAD_X]，边缘刻度标注钳制在画布内（tx ∈ [2, width-文字宽-2]）
   - 留白对称时"点击位置→时间"换算公式不变（center + (x - width/2)*msPerPx 仍成立），仅 xFor/msAt 需计入 PAD_X

【2026-08-25 本轮改动（时间轴控件对齐与文字完整显示）】

1. 修改文件：`src/styles.css`

2. 修改目的：时间轴底部控件水平对齐、时间控件文字完整显示——Element Plus 控件统一 28px 高（--el-component-size 覆盖，与按钮居中对齐）；el-select 加宽到 175px、el-date-editor 加宽到 185px，避免"2022-04-12 00:00"被截断。

3. 关键规则沉淀：Element Plus 组件尺寸用 CSS 变量 `--el-component-size` 覆盖最省事；下拉框宽度需按"最长文字 + 箭头/图标"预留（14px 字体下 16 字符约需 165px+）。

【2026-08-25 本轮改动（Element Plus 时间控件 + 拖动修复）】

1. 修改文件：`package.json`（新增 element-plus 依赖）、`src/main.ts`、`index.html`、`src/components/Timeline.vue`、`src/components/TimeAxis.vue`、`src/styles.css`、`AGENTS.md`

2. 修改目的：时间选择控件改用 Element Plus（el-date-picker 选锚点、el-select filterable 跳转时次，深色主题 html.dark + dark css-vars）；修复时间轴拖不动的问题。

3. 关键规则沉淀：
   - 拖不动根因：视图中心直接用吸附后的 current，时次稀疏（间隔年/天级）时拖动中吸附结果不变 → 视觉完全不动。修复：TimeAxis 增加 viewMs 拖拽视图中心（自由平移、钳制在数据范围内），仅选中时次吸附 emit，松手后 viewMs=null 回归受控
   - Element Plus 深色主题：index.html 加 html.dark + 引入 theme-chalk/dark/css-vars.css；控件显式 import（ElDatePicker/ElSelect/ElOption）以便 vue-tsc 类型检查
   - el-date-picker 用 value-format="YYYY-MM-DD HH:mm:ss"（空格分隔），换算 ISO 时 replace(' ','T')；el-select @change 直接收到 value
   - 原生 datetime-local 无法自定义显示/值格式，需自定义格式时用 Element Plus 或自绘组件

【2026-08-24 本轮改动（时间轴 Canvas 化）】

1. 修改文件：`src/components/TimeAxis.vue`（新建，参考 E:\test\timeline-canvas 项目）、`src/components/Timeline.vue`、`src/styles.css`、`AGENTS.md`

2. 修改目的：时间轴由 range 滑块改为 Canvas 刻度轴，样式与交互参考 timeline-canvas 项目——深色背景+顶部刻度条、自适应刻度线（跨零点标日期）、中央绿色指示线+当前时间、悬停灰线+指针时间、拖拽平移/点击跳转/滚轮缩放（1h~总跨度），顶条绿色刻度标记有文件的时次。

3. 关键规则沉淀：
   - TimeAxis 为受控组件：不保存当前时间，拖拽/点击吸附最近时次后 emit('change')，由 Timeline 写回 store 经 props 回流，单一数据源
   - 时刻吸附用二分查找 timesMs 缓存；刻度间隔从候选档（1m~1440m）取首个 ≥60px 的档位，支持 10 天级大跨度（原项目 24h 上限不适用）
   - 高分屏适配：canvas.width=clientWidth*dpr + ctx.setTransform(dpr,...)；ResizeObserver 监听尺寸重绘
   - 指针交互统一用 Pointer Events + setPointerCapture（替代原项目 mouse/touch 双套处理）；canvas 需 touch-action:none
   - 模板模式无法预知文件存在性，marks 传空数组；清单模式传 files.map(f=>f.time)
   - 已删除废弃的 .timeline-range 滑块样式与 onSeek

【2026-08-24 本轮改动（时间轴时间选择框）】

1. 修改文件：`src/components/Timeline.vue`、`src/styles.css`、`AGENTS.md`

2. 修改目的：时间轴新增时间下拉选择框，快速跳转时次——option 显示格式 YYYY-MM-DD HH:mm，value 为紧凑串 YYYYMMDDHHmm；选中换算回 ISO 时刻（秒固定 00）并 setScreenTime（syncPlay 广播全屏）。

3. 关键规则沉淀：
   - ISO 串 ↔ 紧凑串换算：YYYYMMDDHHmm = t.replace(/[-:T]/g,'').slice(0,12)；还原时按位拼接 'YYYY-MM-DDTHH:mm:00'
   - 激活屏时刻不在时间轴上时 selectValue 为空串，选择框显示空白（预期行为）
   - 原生 datetime-local 控件无法自定义 value 格式，需要指定格式（如 YYYYMMDDHHmm）时用 select/自定义组件实现

【2026-08-24 本轮改动（多屏地图联动开关）】

1. 修改文件：`src/render/mapManager.ts`、`src/store/appStore.ts`、`src/components/Toolbar.vue`、`src/components/RadarScreen.vue`、`AGENTS.md`

2. 修改目的：工具栏新增“地图联动”开关——开启时任一屏缩放/移动地图，其余屏同步相同视野（缩放+平移）；关闭时各屏地图独立操作。

3. 关键规则沉淀：
   - 联动实现：mapManager 模块级登记表 linkedMaps + move 事件转发 setView(center, zoom, {animate:false})；syncing 抑制标记防止 setView 触发其他地图 move 事件造成死循环
   - 新地图 registerMapLink 时若联动开启，立即对齐现有视野（布局切换保持各屏一致）；卸载必须 unregisterMapLink 再 map.remove()
   - 开关状态存 store（appState.syncMap 响应式供 UI），行为开关在 mapManager（setMapLink），Toolbar 同时调两个 setter，render 层不 import store
   - unregisterMapLink 参数需非空断言（onBeforeUnmount 中 map 类型为 LMap | null）

【2026-08-24 本轮改动（产品实况/预报类型字段）】

1. 修改文件：`src/types/index.ts`、`src/config/products.ts`、`public/data/products.json`、`src/api/productApi.ts`、`src/components/ProductList.vue`、`src/styles.css`、`AGENTS.md`、`docs/PRODUCT_GUIDE.md`

2. 修改目的：产品配置增加实况/预报类型字段（RadarProductType：obs/fcst）区分产品资料类型；当前产品均为实况 obs。产品列表显示类型标签（实况绿/预报橙）。

3. 关键规则沉淀：
   - RadarProduct.type 为必填字段；服务器 products.json 缺省或非法值时 normalizeProduct 统一按 obs 处理
   - 新增产品必须在配置中标注 type（静态目录与服务器 JSON 均已补 type: 'obs'）
   - 预报产品（fcst）当前仅做标识区分，时间轴行为差异（起报时间+时效）留待后续按需实现

【2026-08-24 本轮改动（每屏独立平滑开关）】

1. 修改文件：`src/render/radarRenderer.ts`、`src/store/appStore.ts`、`src/components/RadarScreen.vue`、`src/styles.css`、`AGENTS.md`

2. 修改目的：色斑图支持平滑/不平滑切换，多屏时每屏有独立开关（屏头复选框），便于同屏对比平滑效果。

3. 关键规则沉淀：
   - 平滑=GridDataGLFillMode.pixel1（双线性插值后经同一套分级色例取色），不平滑=bitmap（格点填色）；两模式共用色标与缺测处理
   - renderRadar/updateRadarProduct 增加 smooth 参数；新增 updateRadarSmooth(layer, product, smooth) 仅 setDrawOptions 局部刷新，不重建图层
   - ScreenState.smooth 每屏独立（曾先做成全局 appState.smooth，后按需求改为每屏）；setLayout 新增屏沿用上一屏 smooth
   - RadarScreen 判重变量增加 layerSmooth，watch key 含 smooth；仅平滑变化走局部刷新分支
   - 屏头复选框放在 active-dot 之后（dot 保留 margin-left:auto，开关 margin-left:6px），点击冒泡到屏体激活属预期行为

【2026-08-24 本轮改动（时间选择控件 + 无文件提示收尾）】

1. 修改文件：`src/components/Timeline.vue`、`src/components/RadarScreen.vue`、`src/api/configApi.ts`、`src/store/appStore.ts`、`src/App.vue`、`src/styles.css`、`public/data/config.example.json`、`AGENTS.md`

2. 修改目的：时间轴增加时间选择控件——预报模式选“起报时间”（轴起点）、实况模式选“结束时间”（轴终点），改选后按锚点重生成时间轴并跳转；补齐上轮遗留：RadarScreen 无文件提示（清单找不到/模板 404 → 状态栏“该时次无文件”）、config.example.json 示例。

3. 关键规则沉淀：
   - buildTimelineTimes(cfg, anchorMs?) 锚点默认当前时间，控件改选即换锚点重生成
   - 时间选择控件仅配置模式显示（timelineConfig 非空）；datetime-local 值 yyyy-MM-ddTHH:mm，拼 ':00' 还原 ISO 时刻
   - 无文件必须提示“该时次无文件”，不得静默失败（清单模式找不到 / 模板模式 RadarFileMissingError 404 两路径）
   - 原生 datetime-local 用 color-scheme: dark 跟随深色主题

【2026-08-24 本轮改动（配置化时间轴 + 文件路径）】

1. 修改文件：`src/types/index.ts`、`src/api/configApi.ts`（新建）、`src/api/radarApi.ts`、`src/store/appStore.ts`、`src/App.vue`

2. 修改目的：时间轴由服务器配置文件提前确定（不依赖实际文件）；文件路径按配置地址获取。实况模式 now 为结束时间往前推 10 天、预报模式 now 加时效，间隔以分钟为基准（均可配）；时次无文件时 UI 提示。

3. 关键规则沉淀：
   - config.json 三种地址均可指向服务器任意目录：fileUrlTemplate（{time} → yyyyMMddHHmmss，优先）、fileListUrl（清单）、config 本身（setConfigUrl）
   - 配置缺失/非法 → 回退清单模式（时间轴=清单文件时刻），保证无配置部署可用
   - store 新状态：timeline/fileUrlTemplate/timelineConfig；timelineTimes computed 优先配置生成
   - resolveDataUrl：binFile 含 / 或 :// 视为完整地址，纯文件名才拼 data/ 前缀
   - 模板模式 meta.format 固定 'rstm'，实际格式靠魔数检测（isRADAMOSAIC）兜底纠正

【2026-08-24 本轮改动（产品目录服务器化）】

1. 修改文件：`src/api/productApi.ts`（重写）、`public/data/products.json`（新建）

2. 修改目的：产品静态目录改为优先从服务器 JSON 加载，支持部署在服务器任意目录；失败回退内置静态目录。

3. 关键规则沉淀：
   - setProductUrl(url) 可改指向任意地址（默认 data/products.json）；逐项 normalizeProduct 校验，非法项整体回退静态目录
   - findProduct 先查最近一次服务器加载缓存（loadedProducts），再回退静态，保证 radarApi 兜底逻辑一致

【2026-08-24 本轮改动（取值弹窗加经纬度）】

1. 修改文件：`src/components/RadarScreen.vue`、`AGENTS.md`

2. 修改目的：点击取值弹窗在数值下方追加经纬度显示，保留三位小数（如 `29.123°N, 105.456°E`）。

3. 关键规则沉淀：popup 内容用 `<br>` 换行拼接两行——第一行数值+单位，第二行纬度/经度（toFixed(3)）；AGENTS.md 调用链小节已同步。

【2026-08-24 本轮改动（AI 上下文文档）】

1. 修改文件：`AGENTS.md`（新建，项目根目录）

2. 修改目的：添加供各类 AI 编码助手（Claude/Codex/Cursor/opencode 等）读取的开发上下文文档。

3. 关键规则沉淀：
   - AGENTS.md 是跨 AI 工具的通用约定文件，放在项目根目录，内容为事实性速查：技术栈/命令、目录地图、数据契约、调用链、硬性约束（9 条踩坑）、分层依赖方向、常见任务配方、DoD
   - 项目唯一自动验证手段是 `npx vue-tsc --noEmit -p tsconfig.json`（无测试框架）
   - 后续架构/约束变化时须同步更新 AGENTS.md 对应小节

【2026-08-24 本轮改动（说明文档）】

1. 修改文件：`docs/PRODUCT_GUIDE.md`（新建）

2. 修改目的：添加产品开发说明文档——如何新增产品、如何修改色标、取数后如何调用渲染方法。

3. 关键规则沉淀：
   - 新增产品只需在 `src/config/products.ts` 的 PRODUCTS 数组追加一项；仅换配色/单位无需动解析层
   - 色标首档必须是低 value + alpha=0 的透明兜底档，否则 QE bitmap 模式出现"蓝色底色"
   - 文档路径约定：开发指南类文档放 `docs/` 目录

【2026-08-24 本轮改动】

1. 修改文件：`src/render/radarRenderer.ts`、`src/components/RadarScreen.vue`、`src/styles.css`

2. 修改目的：新增“点击色斑图显示数值”功能——地图点击时把经纬度换算为最近格点索引取值，Leaflet popup 弹出该点数值+单位；无数据处点击则关闭弹窗。

3. 关键规则沉淀：
   - 取值函数 `sampleGridValue(grid, lat, lon)` 放在渲染层：row = (lat - yStart) / yDelta 对 yDelta 正负均成立（Math.round 最近邻），越界/缺测/非有限值返回 null
   - renderRadar 的弱值过滤是就地修改 grid.data，RadarScreen 中 layerGrid 与渲染共用同一引用，点击取值天然与显示一致（低于阈值的透明区返回 null）
   - QE LMap 继承 Leaflet L.Map，可直接 map.on('click') / L.popup(...).openOn(map)；popup 用 `.value-popup` 类做深色主题定制
   - 类型检查命令：`npx vue-tsc --noEmit -p tsconfig.json`

# 待办事项清单

> 来源：2026-10-19 全面审查。按 P0→P5 顺序处理，每项完成即在此标注。

- [x] `parse/cinradParser.ts`：合成数据 undef 与 `grid.undef` 不一致，缺测区被渲染为最高档 —— 2026-10-19 已修（不再覆盖哨兵）
- [x] `parse/cinradParser.ts`：`isSynthetic=false` 语义错误（真实文件头 + 合成体数据），UI 应提示示意数据 —— 2026-10-19 已修（恒 true）
- [x] `render/radarRenderer.ts`：弱值过滤就地改数据不可逆 —— 2026-10-19 已修（副本过滤 + 阈值变化重建数据源）
- [x] `components/RadarScreen.vue`：取数竞态；失败与无数据时移除旧图层、清 `layerGrid` —— 2026-10-19 已修（refreshToken + clearLayer）
- [ ] `render/radarRenderer.ts`：`sampleGridValue` 与 bitmap 渲染存在半格偏移（取值与色块不一致，历史遗留，需真实数据比对；已补注释与阈值口径，坐标公式未改）
- [x] 播放/多屏并发：800ms 一档 × 4 屏同步 fetch + 主线程解析 168 万点 —— 2026-10-19 已修（LRU + 在途合并 + 播放避让加载中；未引入 Worker）
- [x] `RadarGrid.data` 由 `number[]` 改 `Float32Array`（168 万点省约 50% 堆内存）—— 2026-10-19 已修
- [x] `fetchRadarGrid` 无缓存：时间来回切换重复下载+解析，加 LRU（键 = binFile + productId）—— 2026-10-19 已修（上限 12 条，约 80MB）
- [x] `mapManager` 地图联动用 `move` 逐帧 `setView`，改 rAF 节流或 `moveend` —— 2026-10-19 已修（rAF 合并 + syncing 前置判断）
- [x] `TimeAxis` 每 `pointermove` 全量重绘且遍历全部 marks；配置 `intervalMinutes=1`+`lookbackDays=10` 会生成 14400 档，需设时次数上限 —— 2026-10-19 已修（rAF 合并 + 二分裁剪 + 上限 3000）
- [x] 抽 `src/utils/datetime.ts`（ISO/紧凑串/格式化）与统一缺测哨兵常量 —— 2026-10-19 已修（新建 datetime.ts + constants.ts）
- [x] 修文档漂移：端口 5173↔5179、`listRadarFiles` 不存在、AGENTS.md 与 package.json 不一致 —— 2026-10-19 已修
- [x] `store` 的 `id` 与数组索引双轨、`getProductByIdSafe` 与 `findProduct` 两套查找语义，需统一 —— 2026-10-19 已修（findScreen + 职责注释）
- [x] 上传文件大小上限、m4/mosaic 网格尺寸上限；fetch 超时；产品色标校验（升序 + 首档透明）；初始化失败 UI 提示 —— 2026-10-19 已修（200MB / 10s 超时 / 严格校验+首档告警 / ElMessage；**网格点数上限已于同日按需求取消**）
- [P3] 审查报告 P3 剩余项（未纳入本轮）：manifest.json 结构校验与 `hasData=false` 提示、`refresh` 提前返回时的状态残留、`TimeAxis` 初始 spanHours 不自适应、时区隐式假设（一律按部署本地时区解释）
- [P4] 天地图 key 配置化；popup 内容改 DOM 节点（避免配置注入）；构建 `base` 支持子路径部署
- [P5] 引入 vitest（三个解析器 + sampleGridValue + buildTimelineTimes/snapNearestTime）、ESLint、CI；依赖升级（vue 3.5 / vite 7 / vue-tsc 2.x，compressjs 移 devDependencies）

# 遗留问题&注意事项

- manifest.json 已重新生成（6 条，2024-06-21 新数据），但有缺口待处理：
  1) 手工放置的 .bin.bin（无对应 .bz2）未登记——其中 Z_RADR_I_Z9543_20240621130000_O_DOR_SA_CAP_FMT.bin.bin 为 5.9MB 合法 RSTM（有效数据被漏登）；prepare-data.cjs 第 2 步只登记 RADAMOSAIC .bin，需扩展支持 RSTM 命名的 .bin.bin
  2) 3 个 .bz2（Z9536_120000、Z9543_160000、Z9543_180000）首 4 字节全 0，非合法 bz2 也非 RSTM，hasData=false 走合成兜底（属数据本身问题）
  3) 脚本会用 0 字节覆盖已有 .bin.bin（解压失败时），建议加"已有非空产物则跳过解压"保护
- ★ 点击取值弹窗数值与色块颜色不一致（用户截图：色块品红 60~65 档，弹窗显示 54.0 dBZ）。已排查结论：QE BitmapColorScaleGL.createFromStopRules 的 value→颜色分段映射验证正确（54 → 红档）；疑似 sampleGridValue 的 Math.round 最近邻取样与 QE bitmap 渲染的格点定位（格点=像元中心还是左下角锚点）存在半格偏移，或 yDelta<0 行序理解不一致。待继续定位（可用真实数据对比点击点邻域格点值与渲染色档）。
- 时间轴 / 配置 / 底图 / 色标范围 / 分屏切换等功能已通过多轮 `vue-tsc` 与 `npm run build` 验证，浏览器交互项已由用户手工确认；无自动化测试框架（P5 待补 vitest）。
- ★ m4 格点产品与 RSTM 基数据同经纬度数值不同**属正常现象，不是取值 bug** ★
  m4（MICAPS Diamond 4）是经质控 / 多仰角合成 / 平滑插值后的**格点产品**，格距与起止经纬度由文件头给定；
  RSTM（`*.bin.bz2`）是该次体扫的**原始基数据**（单一仰角层、极坐标）。
  取值口径也不同：m4 走栅格最近邻（`utils/gridSample`），RSTM 优先走极坐标原始径向最近邻
  （`parse/valueQuery.rawValueAt` → `sampleRstmValue`，无网格量化）。
  两者采样到的“体”本就不同；弱回波（低于显示阈值）区间相差数 dBZ 更常见。
  跨数据源比对前须统一：同一产品 / 同一仰角 / 同一处理链，并核对 m4 文件头的格距与起止经纬度。
