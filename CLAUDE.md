# 项目基础信息

- 项目：二维雷达显示平台（radar2-2d-platform）
- 技术栈：Vite 5 + TypeScript 5.4 + Vue 3.4（script setup）+ QuickEarth 3.2.2（@quickearth/core、@quickearth/leaflet，LMap 继承自 Leaflet L.Map）+ Leaflet 1.9.4
- 目录结构：
  - `src/parse/`：解析层，把二进制/文本解析为统一网格结构 RadarGrid（mosaic / rstm / m4 三种格式）
  - `src/api/`：接口层，产品列表与雷达文件清单、取数
  - `src/render/`：渲染层，`radarRenderer.ts` 把 RadarGrid 渲染为 LPixelLayer 色斑图（bitmap 格点填色、不平滑）；`mapManager.ts` 创建地图与天地图底图
  - `src/store/appStore.ts`：Vue reactive 单例全局状态（多屏 / 产品 / 时间 / 播放）
  - `src/components/`：Toolbar / ProductList / Timeline / RadarScreen（单屏容器）/ Legend
- 环境配置：`npm run dev`（scripts/dev.cjs，端口 5173）、`npm run build`；类型检查 `npx vue-tsc --noEmit`
- 数据契约：`src/types/index.ts` 中 RadarGrid —— x 经度/y 纬度，data 行优先一维数组，yDelta<0 表示第 0 行在最北；undef 为缺测哨兵值

# 迭代变更日志（按时间倒序）

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

# 遗留问题&注意事项

- ★ 点击取值弹窗数值与色块颜色不一致（用户截图：色块品红 60~65 档，弹窗显示 54.0 dBZ）。已排查结论：QE BitmapColorScaleGL.createFromStopRules 的 value→颜色分段映射验证正确（54 → 红档）；疑似 sampleGridValue 的 Math.round 最近邻取样与 QE bitmap 渲染的格点定位（格点=像元中心还是左下角锚点）存在半格偏移，或 yDelta<0 行序理解不一致。待继续定位（可用真实数据对比点击点邻域格点值与渲染色档）。
- 本轮时间轴/配置改造后未做浏览器端手工验证（无测试框架，仅 vue-tsc 通过）；建议 dev 起服后验证：配置模式时间选择控件重生成、模板模式 404 提示、清单回退模式（无 config.json）demo 行为不变。
