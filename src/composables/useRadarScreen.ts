/**
 * composables/useRadarScreen.ts —— 单屏地图与图层状态机
 *
 * 从 RadarScreen.vue 抽出的非模板逻辑：
 *   - 地图创建/销毁、尺寸监听、底图、多屏联动；
 *   - watch 本屏产品/时间/平滑/范围/仰角 → 取数并渲染（局部更新优先）；
 *   - 并发控制：refreshToken + inflight abort；
 *   - 点击/坐标取值、上传文件识别与渲染。
 *
 * 组件只负责布局与子组件组合；本文件不返回响应式图层对象
 * （map/layer/grid 用普通变量保存，避免被 Vue 代理）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  appState,
  getProductByIdSafe,
  setScreenElevations,
  setScreenLoading,
  setScreenStatus
} from '../store/appStore';
import {
  createRadarMap,
  applyBaseMap,
  registerMapLink,
  unregisterMapLink
} from '../render/mapManager';
import {
  renderRadar,
  updateRadarProduct,
  updateRadarSmooth,
  updateRadarRange,
  removeRadar,
  firstVisibleThreshold
} from '../render/radarRenderer';
import { valueRangeKey } from '../utils/range';
import {
  fetchRadarGrid,
  fetchRstmVolume,
  buildFileMetaFromTemplate,
  parseUploadedFile,
  RadarFileMissingError
} from '../api/radarApi';
import { volumeToGrid } from '../parse/cinradVolume';
// 取值逻辑（字段映射 / 原始值 / 九点均值 / 可见性）已抽成纯函数，便于单测
import { fieldForProduct, queryValue } from '../parse/valueQuery';
import { ElMessage } from 'element-plus';
import * as L from 'leaflet';
import type { LMap, LPixelLayer } from '@quickearth/leaflet';
import type { RadarGrid, RadarQueryResult, RstmVolume, ValueRange } from '../types';
import { registerUploadHandler, unregisterUploadHandler } from './uploadRouter';
import { getLocalFile } from '../api/localFiles';

/** 上传 / 本地文件夹文件解析结果的类型（由 parseUploadedFile 推断，避免重复声明） */
type ParsedRadarData = Awaited<ReturnType<typeof parseUploadedFile>>;

/**
 * @param screenId 屏的稳定 id（不是数组下标）
 */
export function useRadarScreen(screenId: number) {
  /** 地图容器 id（与模板 :id 对应，多屏时必须唯一） */
  const mapElId = 'radar-map-' + screenId;
  const elRef = ref<HTMLDivElement | null>(null);

  /* 地图 / 图层实例（非响应式对象，仅作引用保存） */
  let map: LMap | null = null;
  let layer: LPixelLayer | null = null;
  /* 当前图层对应的数据与“版本”标记，用于判重避免无意义重建 */
  let layerGrid: RadarGrid | null = null;
  let layerTime = '';
  let layerProductId = '';
  let layerThreshold = Number.NEGATIVE_INFINITY; // 当前图层渲染时的弱值阈值
  let layerSmooth = false;                       // 当前图层渲染时的平滑开关（每屏独立）
  let layerRange: ValueRange | null = null;      // 当前图层使用的色标数值范围（null=全范围）
  /**
   * 当前数据的 RSTM 基数据体（9 仰角层）：非 null 表示本屏数据支持仰角切换。
   * 普通拼图 / m4 / 合成 RSTM 为 null（无仰角维度）。
   */
  let currentVolume: RstmVolume | null = null;
  /** 当前图层使用的仰角索引（-1 表示尚未渲染过仰角数据） */
  let layerElevation = -1;
  /** 上一次自动定位使用的数据范围（同范围不重复定位，避免打断用户的缩放/平移） */
  let fittedBounds: L.LatLngBounds | null = null;

  /**
   * 请求序号（并发控制）：
   * 每次取数 / 上传自增，异步返回后只有“最后一次操作”的结果允许落到图层。
   * 否则播放（800ms 一档）或快速拖时间轴时，先发后至的旧响应会覆盖新时次，
   * 屏上出现“时间显示 A、画面是 B”的错位。
   */
  let refreshToken = 0;

  /**
   * 当前在途取数的 AbortController。
   *
   * refreshToken 只能「丢弃结果」，无法停止已经开始的下载：单个 mosaic 文件
   * 达 35MB，快速拖时间轴时多个请求会同时占用带宽与内存。这里在每次取数前
   * abort 上一个请求，配合 refreshToken 形成「取消 + 丢弃」双保险。
   */
  let inflight: AbortController | null = null;

  /**
   * 清空本屏图层与取值数据。
   * 用于“该时次无数据”“加载失败”两种场景：必须同时清掉旧画面与 layerGrid，
   * 否则屏幕仍显示上一时次的色斑图，点击取值还会返回旧数值，与状态提示矛盾。
   */
  function clearLayer(): void {
    removeRadar(map, layer);
    layer = null;
    layerGrid = null;
    layerTime = '';
    layerProductId = '';
    layerThreshold = Number.NEGATIVE_INFINITY;
    layerRange = null;
    currentVolume = null;
    layerElevation = -1;
  }

  /**
   * 根据数据网格的地理范围自动定位地图。
   *
   * 触发策略（避免每次切时次都把用户缩放的视野重置）：
   *   - 首次加载数据：定位；
   *   - 数据范围发生变化（上传新文件、清单模式下切到不同站点的时次）：重新定位；
   *   - 同一区域切时次/切产品：范围完全相同 → 保持当前视野不动。
   *
   * @param grid 解析后的网格（xStart/yStart/delta/size 描述格点范围）
   */
  function fitToGrid(grid: RadarGrid): void {
    if (!map) return;

    const lon1 = grid.xStart;
    const lon2 = grid.xStart + (grid.xSize - 1) * grid.xDelta;
    const lat1 = grid.yStart;
    const lat2 = grid.yStart + (grid.ySize - 1) * grid.yDelta;

    // yDelta 可能为负，统一按 min/max 构造包围盒
    const bounds = L.latLngBounds(
      [Math.min(lat1, lat2), Math.min(lon1, lon2)],
      [Math.max(lat1, lat2), Math.max(lon1, lon2)]
    );

    // 容差 1e-6 度：同一网格浮点计算结果完全一致，不同区域必然超出
    if (fittedBounds && fittedBounds.equals(bounds, 1e-6)) return;
    fittedBounds = bounds;

    // padding 给数据边缘留白，避免色斑贴着容器边框
    map.fitBounds(bounds, { padding: [24, 24], animate: false });
  }

  /**
   * 本屏状态：按 id 查找，而不是把 screenId 当数组下标。
   * store 侧已统一为“id 是稳定标识”，组件内不得再依赖 “id === 下标” 的巧合。
   */
  const screen = computed(() => appState.screens.find((s) => s.id === screenId));

  const isActive = computed(() => appState.activeScreenId === screenId);
  const productId = computed(() => screen.value?.productId ?? 'dBZ');

  /**
   * 取数 + 渲染。
   * 依据本屏的 time 找到清单文件 → fetchRadarGrid → renderRadar。
   *
   * 并发约束：函数入口先取本次操作序号 token，任何 await 之后都要比对
   * token === refreshToken，不相等说明用户已发起更新的操作，本次结果一律丢弃
   * （既不能渲染，也不能改状态），否则旧时次会覆盖新时次。
   */
  async function refresh(): Promise<void> {
    const sc = screen.value;
    if (!sc || !map) return;

    // 每次刷新先复位忙标记：旧请求的 token 已作废，其 catch 不会再改状态；
    // 若本次走取数分支，下面会重新置 true。
    setScreenLoading(screenId, false);

    const product = getProductByIdSafe(sc.productId);
    if (!product || !sc.time) return;

    // 本屏色标显示范围（null=全范围）；范围外的格点在渲染时置为缺测
    const range = sc.valueRange ?? null;

    // 本次操作的序号（自增后，所有更早的未完成请求全部作废）
    const token = ++refreshToken;

    // 完全没变化 → 跳过（此时 token 已自增，顺带作废可能的过期在途请求）
    // ★ 仰角只在体数据下参与判重 ★
    //   非体数据 layerElevation 恒为 -1，若无条件比较会永远判为“有变化”，
    //   白白重走局部更新；体数据则必须比较，否则切换仰角会被这里直接跳过（无响应）。
    if (
      layer &&
      layerTime === sc.time &&
      layerProductId === product.id &&
      layerSmooth === sc.smooth &&
      valueRangeKey(layerRange) === valueRangeKey(range) &&
      (!currentVolume || layerElevation === sc.elevationIndex)
    ) {
      return;
    }

    try {
      // 时间未变 → 局部更新（仰角 / 产品色标 / 范围 / 平滑模式），不重新下载数据。
      // ★ 必须先于文件清单解析 ★
      //   上传数据只标记为本屏当前时次，其文件并不在数据服务清单里；
      //   若先按清单匹配会误判“该时次无数据”并清空上传画面（表现为切换仰角无响应）。
      if (layer && layerGrid && layerTime === sc.time) {
        // ① 体数据（RSTM 基数据）：仰角或产品（字段）变化 → 重新栅格化并重建图层。
        //    仰角层 + 字段共同决定栅格内容，仅换色标（updateRadarProduct）会画出错误数据；
        //    只重建图层，不重新下载/解压（36MB 文件 + 1.5s 解压不能每次切换都来一遍）。
        if (
          currentVolume &&
          (layerElevation !== sc.elevationIndex || layerProductId !== product.id)
        ) {
          const grid = volumeToGrid(currentVolume, sc.elevationIndex, fieldForProduct(product.id));
          if (!grid) return; // 该层 / 该字段无有效数据时保持原画面
          removeRadar(map, layer);
          layerGrid = grid;
          layer = renderRadar(map, grid, product, sc.smooth, range);
          layerElevation = sc.elevationIndex;
          layerProductId = product.id;
          layerThreshold = firstVisibleThreshold(product);
          layerSmooth = sc.smooth;
          layerRange = range;
          // 不同仰角层 / 字段的数据范围可能不同，重新定位到新数据范围
          fitToGrid(grid);
          return;
        }

        // ② 产品变化（阈值可能变）+ 范围可能同时变化：统一按原始网格重建过滤口径
        if (layerProductId !== product.id) {
          updateRadarProduct(layer, layerGrid, layerThreshold, product, sc.smooth, range, layerRange);
          layerProductId = product.id;
          layerThreshold = firstVisibleThreshold(product);
          layerRange = range;
        } else if (valueRangeKey(layerRange) !== valueRangeKey(range)) {
          // ③ 仅范围变化：必须重建数据源（放宽范围时要恢复之前被裁掉的值），
          //    并强制刷新绘制选项触发 GL 重绘（只换数据源画面不会立即更新）
          updateRadarRange(layer, layerGrid, product, sc.smooth, range);
          layerRange = range;
        } else if (layerSmooth !== sc.smooth) {
          // ④ 仅平滑开关变化
          updateRadarSmooth(layer, product, sc.smooth);
        }
        layerSmooth = sc.smooth;
        return;
      }

      // ★ 本地文件夹文件优先：按当前时次匹配本地 File，直接解析，不请求服务器 ★
      // 本地时次与服务器清单分离（store.localFileTimes），因此“只上传”模式下同样可用。
      const localFile = getLocalFile(sc.time);
      if (localFile) {
        setScreenLoading(screenId, true);
        setScreenStatus(screenId, '加载中…');
        const data = await parseUploadedFile(localFile, product.id);
        if (token !== refreshToken) return;
        applyParsedData(data, localFile.name);
        setScreenLoading(screenId, false);
        return;
      }

      // ★ 数据来源为“只通过上传文件”时，不请求服务器数据 ★
      // 走到这里说明是首次进入或切换了时次（同屏局部更新已在上面返回）：
      // 清空画面等待用户上传，只有上传时的那个时次有画面。
      if (appState.dataSourceMode === 'upload') {
        clearLayer();
        setScreenStatus(screenId, '');
        return;
      }

      // 需要重新取数：文件路径解析（模板模式按时刻构造地址，404 → 提示无数据；
      // 清单模式按时间在清单中精确匹配，清单无此时次 → 提示无数据）
      const file = appState.fileUrlTemplate
        ? buildFileMetaFromTemplate(appState.fileUrlTemplate, sc.time)
        : (appState.files.find((f) => f.time === sc.time) ?? null);
      if (!file) {
        // 无数据时必须清掉上一时次的画面，否则屏上残留旧色斑图却提示“无数据”
        clearLayer();
        setScreenStatus(screenId, '该时次无数据');
        return;
      }

      // 时间变化或首次 → 拉取并解析数据，重建图层
      setScreenLoading(screenId, true);
      setScreenStatus(screenId, '加载中…');
      // 取消上一次仍在下载的请求：否则切时次时会有多个大文件并行下载
      inflight?.abort();
      inflight = new AbortController();
      const signal = inflight.signal;

      // —— RSTM 单站基数据：优先解析 9 仰角层体数据（真实 Z/V/W/ZDR/KDP/CC）——
      //    旧合成文件 / 损坏文件解析不出体结构 → 回退合成网格（与改造前行为一致）
      let grid: RadarGrid;
      let volume: RstmVolume | null = null;

      if (file.format === 'rstm') {
        volume = await fetchRstmVolume(file, signal);
        if (volume) {
          grid = volumeToGrid(volume, sc.elevationIndex, fieldForProduct(product.id)) as RadarGrid;
        } else {
          setScreenElevations(screenId, []);
          grid = await fetchRadarGrid(file, product.id, signal);
        }
      } else {
        setScreenElevations(screenId, []);
        grid = await fetchRadarGrid(file, product.id, signal);
      }

      // 请求期间用户又切了时次 / 产品（或上传了文件）→ 本次结果作废
      if (token !== refreshToken) return;

      // 仰角列表写进 store：非空时屏头显示仰角选择器
      currentVolume = volume;
      layerElevation = volume ? sc.elevationIndex : -1;
      if (volume) setScreenElevations(screenId, volume.elevations);

      removeRadar(map, layer);
      layerGrid = grid;
      layer = renderRadar(map, grid, product, sc.smooth, range);
      layerTime = grid.time;
      layerProductId = product.id;
      layerThreshold = firstVisibleThreshold(product);
      layerSmooth = sc.smooth;
      layerRange = range;
      // 数据加载完成 → 按数据范围定位（同区域切时次不会重置用户视野）
      fitToGrid(grid);
      setScreenLoading(screenId, false);
      setScreenStatus(
        screenId,
        grid.isSynthetic ? '示意数据' : ''
      );
    } catch (e) {
      // 过期请求的失败同样不能影响当前屏的状态
      if (token !== refreshToken) return;
      setScreenLoading(screenId, false);
      // 主动取消（切时次/换产品/所有等待者都取消）不是错误：
      // 保留当前画面，同时清掉“加载中…”，避免 App 播放避让永久暂停。
      if (e instanceof DOMException && e.name === 'AbortError') {
        setScreenStatus(screenId, '');
        return;
      }
      console.error('[RadarScreen] 渲染失败：', e);
      // 失败时保留旧画面会让用户误读成“该时次的数据”，因此一并清空
      clearLayer();
      // 404（模板模式时间轴时次未必有文件）→ 提示无数据；其余 → 加载失败
      setScreenStatus(screenId, e instanceof RadarFileMissingError ? '该时次无数据' : '加载失败');
    }
  }

  /**
   * 在指定经纬度取本屏数值：地图弹窗 + 返回面板结果。
   *
   * 取值与判定全部在 `queryValue`（纯函数，可单测）里完成；
   * 这里只保留两件 UI 相关的事：地图弹窗与消息提示。
   *
   * 结果同时包含两种数值：
   *   - **原始值**：中心库最近邻（保峰值，与图面颜色同口径）；
   *   - **九点均值**：中心 + 周围 8 个库的平均（抑噪，但会压低峰值）。
   * 图上透明（低于阈值 / 超出色标范围）时仍然给出数值并注明原因。
   *
   * @param lat    纬度
   * @param lon    经度
   * @param notify 需要提示时传 true（坐标查询）；点击地图保持静默
   */
  function showValueAt(lat: number, lon: number, notify = false): RadarQueryResult | null {
    if (!map) return null;

    const product = getProductByIdSafe(screen.value?.productId ?? 'dBZ');
    const result = queryValue({
      lat,
      lon,
      product,
      volume: currentVolume,
      elevationIndex: layerElevation,
      grid: layerGrid,
      range: screen.value?.valueRange ?? null,
      threshold: firstVisibleThreshold(product)
    });

    // —— 地图弹窗：展示可见值（优先）或原始值 ——
    if (result.shown === null) {
      map.closePopup();
      if (notify) ElMessage.warning('该位置无数据（超出数据范围或无回波）');
      return result;
    }

    const unit = product.unit ? ' ' + product.unit : '';
    const lines = [`${result.shown.toFixed(1)} ${product.unit}`];
    if (result.mean !== null) {
      lines.push(
        `9点均值 ${result.mean.toFixed(1)} ${product.unit}（${result.validCount}/${result.totalCount}）`
      );
    }
    if (result.note) lines.push(`<span style="color:#ffb454">${result.note}</span>`);
    lines.push(`${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E`);

    L.popup({ closeButton: false, className: 'value-popup' })
      .setLatLng([lat, lon])
      .setContent(lines.join('<br>'))
      .openOn(map as unknown as L.Map);

    if (notify && result.note) {
      ElMessage.info(`该位置 ${result.shown.toFixed(1)}${unit}：${result.note}`);
    }

    return result;
  }

  /** 地图点击取值（静默：无数据时只关弹窗，不打扰用户） */
  function onMapClick(e: L.LeafletMouseEvent): void {
    showValueAt(e.latlng.lat, e.latlng.lng);
  }

  /**
   * 把解析结果应用为本屏图层（上传文件与本地文件夹文件共用）。
   * RSTM 体数据按当前仰角层栅格化并保留仰角维度；单层数据清除仰角维度。
   * @param data  解析结果（volume 或 grid）
   * @param label 数据来源文件名，写入屏头状态便于区分
   */
  function applyParsedData(data: ParsedRadarData, label: string): void {
    const sc = screen.value;
    if (!sc || !map) return;
    const product = getProductByIdSafe(sc.productId);

    let grid: RadarGrid;
    if (data.kind === 'volume') {
      // 越界层号钳制到体数据实际层数（与 setScreenElevations 的钳制口径一致）
      const elevIdx = Math.min(
        Math.max(sc.elevationIndex, 0),
        data.volume.elevations.length - 1
      );
      // 当前层无有效数据时回退最低仰角层
      const g =
        volumeToGrid(data.volume, elevIdx, fieldForProduct(product.id)) ??
        volumeToGrid(data.volume, 0, fieldForProduct(product.id));
      if (!g) throw new Error('基数据体无有效数据');
      grid = g;
      currentVolume = data.volume;
      layerElevation = elevIdx;
      setScreenElevations(screenId, data.volume.elevations);
    } else {
      grid = data.grid;
      currentVolume = null;
      layerElevation = -1;
      setScreenElevations(screenId, []);
    }

    removeRadar(map, layer);
    layerGrid = grid;
    // 本地数据同样遵循本屏的色标范围（范围外渲染为透明）
    layer = renderRadar(map, grid, product, sc.smooth, sc.valueRange ?? null);
    layerTime = sc.time;
    layerProductId = product.id;
    layerThreshold = firstVisibleThreshold(product);
    layerSmooth = sc.smooth;
    layerRange = sc.valueRange ?? null;
    // 数据区域可能与当前视野不同，重新定位到新数据范围
    fitToGrid(grid);
    // 状态栏同时显示文件名，便于多屏 / 多文件时区分数据来源
    setScreenStatus(screenId, '上传数据 · ' + label);
  }

  /**
   * 本屏上传雷达数据文件：读取 → 格式识别（见 radarApi.parseUploadedFile）→ 本屏渲染。
   * RSTM 标准基数据体解析为 9 仰角层体数据（屏头出现仰角选择器，可切换层）；
   * 拼图 / m4 / 合成 RSTM 为单层网格（无仰角维度）。
   * 识别成功/失败均用 ElMessage 提示，屏状态栏同步标记数据来源与文件名。
   * 上传数据仅作为本屏当前视图（记为当前时次：切产品/仰角走局部刷新），切换时次后恢复时间轴数据。
   */
  async function onUpload(file: File): Promise<void> {
    if (!file || !map) return;
    const sc = screen.value;
    if (!sc) return;
    // 上传与取数共用请求序号：识别期间若用户切换时次/产品，本次上传结果作废，
    // 避免几百毫秒后旧上传文件覆盖用户新选的时次画面。
    const token = ++refreshToken;
    try {
      setScreenLoading(screenId, true);
      setScreenStatus(screenId, '识别中…');
      const data = await parseUploadedFile(file, sc.productId);
      if (token !== refreshToken) return;
      applyParsedData(data, file.name);
      setScreenLoading(screenId, false);
      ElMessage.success(`文件识别成功：${file.name}`);
    } catch (e) {
      // 过期上传的失败提示同样不应打扰当前操作（新操作负责管理 loading）
      if (token !== refreshToken) return;
      setScreenLoading(screenId, false);
      console.error('[RadarScreen] 上传文件识别失败：', e);
      setScreenStatus(screenId, '文件格式不符');
      ElMessage.error(e instanceof Error ? e.message : '文件格式不符合预设格式');
    }
  }

  /**
   * 地图容器的尺寸监听。
   *
   * ★ 布局切换后必须重新量算地图 ★
   *   1 屏 → 6 屏时地图容器宽高减半，但 Leaflet / QE 的 GL 图层仍按旧尺寸
   *   生成纹理与投影，表现为“色斑不在正确地理位置，缩放或拖动地图才回正”。
   *   invalidateSize 会触发 resize 事件，QE 据此重建 canvas 与纹理。
   */
  let mapResizeObserver: ResizeObserver | null = null;
  let mapResizeRaf = 0;

  onMounted(() => {
    const el = elRef.value;
    if (!el) return; // 容器未就绪（极端时序），跳过
    map = createRadarMap(el);
    // 按当前全局底图模式初始化：admin=天地图；border=国界/省界矢量
    void applyBaseMap(map, appState.baseMap);
    registerMapLink(map); // 纳入多屏地图联动（缩放/平移同步）
    map.on('click', onMapClick);
    // 注册本屏上传处理器：供左侧「文件夹文件」区块把文件路由到本屏渲染
    registerUploadHandler(screenId, onUpload);

    // 布局切换会连续触发多次尺寸变化，用 rAF 合并成一次 invalidateSize
    mapResizeObserver = new ResizeObserver(() => {
      if (mapResizeRaf) return;
      mapResizeRaf = requestAnimationFrame(() => {
        mapResizeRaf = 0;
        // 容器被隐藏时尺寸为 0，此时量算没有意义
        if (!el.clientWidth || !el.clientHeight) return;

        map?.invalidateSize({ animate: false });

        // ★ 量算之后必须再强制重绘一次 ★
        //   invalidateSize 会触发 QE 的 canvas resize（重建 framebuffer），
        //   但 GL 图层没有持续渲染循环，resize 后不会自动重绘，
        //   表现为“切屏后色斑消失，要拖动/缩放地图才出现”。
        layer?.reinit();
      });
    });
    mapResizeObserver.observe(el);

    refresh();
  });

  onBeforeUnmount(() => {
    // 注销本屏上传处理器，避免卸载后残留对已销毁地图/图层的引用
    unregisterUploadHandler(screenId);
    // 作废所有在途请求：销毁后再回来的响应不得继续操作已移除的地图/图层
    refreshToken++;
    // 同时真正取消下载，避免卸载后仍有一个 35MB 文件在后台跑完
    inflight?.abort();
    inflight = null;

    // 停止尺寸监听并取消待执行的 invalidateSize，避免销毁后继续操作地图
    if (mapResizeRaf) {
      cancelAnimationFrame(mapResizeRaf);
      mapResizeRaf = 0;
    }
    mapResizeObserver?.disconnect();
    mapResizeObserver = null;

    removeRadar(map, layer);
    if (map) unregisterMapLink(map);
    if (map && typeof map.remove === 'function') map.remove();
    map = null;
    layer = null;
    layerGrid = null;
    currentVolume = null;
  });

  // 本屏 产品/时间/平滑开关/色标范围/仰角 变化 → 自动重渲染
  watch(
    () => {
      // 依赖本屏五个可变字段；按 id 取屏，避免依赖数组下标
      const s = screen.value;
      return s
        ? s.productId +
            '|' +
            s.time +
            '|' +
            (s.smooth ? 1 : 0) +
            '|' +
            valueRangeKey(s.valueRange) +
            '|' +
            s.elevationIndex
        : '';
    },
    () => refresh()
  );

  return { elRef, mapElId, isActive, productId, showValueAt, onUpload };
}
