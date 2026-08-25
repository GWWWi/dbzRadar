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

# 遗留问题&注意事项

- manifest.json 已重新生成（6 条，2024-06-21 新数据），但有缺口待处理：
  1) 手工放置的 .bin.bin（无对应 .bz2）未登记——其中 Z_RADR_I_Z9543_20240621130000_O_DOR_SA_CAP_FMT.bin.bin 为 5.9MB 合法 RSTM（有效数据被漏登）；prepare-data.cjs 第 2 步只登记 RADAMOSAIC .bin，需扩展支持 RSTM 命名的 .bin.bin
  2) 3 个 .bz2（Z9536_120000、Z9543_160000、Z9543_180000）首 4 字节全 0，非合法 bz2 也非 RSTM，hasData=false 走合成兜底（属数据本身问题）
  3) 脚本会用 0 字节覆盖已有 .bin.bin（解压失败时），建议加"已有非空产物则跳过解压"保护
- ★ 点击取值弹窗数值与色块颜色不一致（用户截图：色块品红 60~65 档，弹窗显示 54.0 dBZ）。已排查结论：QE BitmapColorScaleGL.createFromStopRules 的 value→颜色分段映射验证正确（54 → 红档）；疑似 sampleGridValue 的 Math.round 最近邻取样与 QE bitmap 渲染的格点定位（格点=像元中心还是左下角锚点）存在半格偏移，或 yDelta<0 行序理解不一致。待继续定位（可用真实数据对比点击点邻域格点值与渲染色档）。
- 本轮时间轴/配置改造后未做浏览器端手工验证（无测试框架，仅 vue-tsc 通过）；建议 dev 起服后验证：配置模式时间选择控件重生成、模板模式 404 提示、清单回退模式（无 config.json）demo 行为不变。
