<!--
  RadarScreen.vue —— 单块雷达屏（渲染容器）

  职责：
    - onMounted：创建 QuickEarth 地图 + 叠加天地图底图；
    - watch 本屏 productId / time / smooth：变化时通过 radarApi 取数并渲染
      （时间变 → 数据变 → 重建图层；仅产品/平滑变 → 局部刷新绘制选项）；
    - 屏头平滑开关：每屏独立切换色斑图平滑/不平滑（多屏对比用）；
    - 屏头上传按钮（每屏独立）：上传本地雷达数据文件，
      格式识别（mosaic/rstm/m4）通过后在本屏渲染，不符则提示；
    - 点击屏体 → 设为激活屏；
    - onBeforeUnmount：销毁地图，防止内存泄漏与重复初始化报错。
-->
<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, ref, computed } from 'vue';
import {
  appState,
  getProductByIdSafe,
  setScreenStatus,
  setScreenSmooth,
  setScreenElevations,
  setScreenElevation,
  setActiveScreen
} from '../store/appStore';
import { createRadarMap, applyBaseMap, registerMapLink, unregisterMapLink } from '../render/mapManager';
import {
  renderRadar,
  updateRadarProduct,
  updateRadarSmooth,
  updateRadarRange,
  removeRadar,
  firstVisibleThreshold,
  sampleGridValue
} from '../render/radarRenderer';
import { valueRangeKey } from '../utils/range';
import {
  fetchRadarGrid,
  fetchRstmVolume,
  buildFileMetaFromTemplate,
  parseUploadedFile,
  RadarFileMissingError
} from '../api/radarApi';
import { volumeToGrid, MOMENT_FIELD } from '../parse/cinradVolume';
import { ElMessage } from 'element-plus';
import Legend from './Legend.vue';
import * as L from 'leaflet';
import type { LMap } from '@quickearth/leaflet';
import type { LPixelLayer } from '@quickearth/leaflet';
import type { RadarGrid, RstmVolume, ValueRange } from '../types';
import type { RstmField } from '../parse/cinradVolume';

/** 组件入参：屏序号 */
const props = defineProps<{ screenId: number }>();

/** 地图容器 id（与模板 :id 对应，多屏时必须唯一） */
const mapElId = 'radar-map-' + props.screenId;
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
 * 当前产品应对应的 RSTM 字段。
 *
 * 产品 id 与字段名一致（见 config/products.ts：dBZ/dBT/V/W/ZDR/CC/KDP/SNRH），
 * 因为标准格式一个仰角层含 9 个矩（字段），而渲染链路一次只画一个数值场。
 * 未知 id（理论不存在）回退滤波后反射率 dBZ。
 */
function fieldForProduct(productId: string): RstmField {
  return productId in MOMENT_FIELD ? (productId as RstmField) : 'dBZ';
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
const screen = computed(() => appState.screens.find((s) => s.id === props.screenId));

const isActive = computed(() => appState.activeScreenId === props.screenId);
const status = computed(() => screen.value?.status ?? '');

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

  const product = getProductByIdSafe(sc.productId);
  if (!product || !sc.time) return;

  // 本屏色标显示范围（null=全范围）；范围外的格点在渲染时置为缺测
  const range = sc.valueRange ?? null;

  // 本次操作的序号（自增后，所有更早的未完成请求全部作废）
  const token = ++refreshToken;

  // 文件路径解析：模板模式按时刻构造地址（404 → 提示无数据）；
  // 清单模式按时间在清单中精确匹配，清单无此时次 → 提示无数据
  const file = appState.fileUrlTemplate
    ? buildFileMetaFromTemplate(appState.fileUrlTemplate, sc.time)
    : (appState.files.find((f) => f.time === sc.time) ?? null);
  if (!file) {
    // 无数据时必须清掉上一时次的画面，否则屏上残留旧色斑图却提示“无数据”
    clearLayer();
    setScreenStatus(props.screenId, '该时次无数据');
    return;
  }

  // 完全没变化 → 跳过（此时 token 已自增，顺带作废可能的过期在途请求）
  if (
    layer &&
    layerTime === sc.time &&
    layerProductId === product.id &&
    layerSmooth === sc.smooth &&
    valueRangeKey(layerRange) === valueRangeKey(range)
  ) {
    return;
  }

  try {
    // 时间未变 → 局部更新（仰角 / 产品色标 / 范围 / 平滑模式），不重新下载数据
    if (layer && layerGrid && layerTime === sc.time) {
      // ① 仰角切换（RSTM 基数据体）：复用已解析的体数据重新栅格化，
      //    只重建图层，不重新下载/解压（36MB 文件 + 1.5s 解压不能每次切换都来一遍）
      if (currentVolume && layerElevation !== sc.elevationIndex) {
        const grid = volumeToGrid(currentVolume, sc.elevationIndex, fieldForProduct(product.id));
        if (!grid) return; // 该仰角层无有效数据时保持原画面
        removeRadar(map, layer);
        layerGrid = grid;
        layer = renderRadar(map, grid, product, sc.smooth, range);
        layerElevation = sc.elevationIndex;
        // 不同仰角层覆盖范围不同，重新定位到新数据范围
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

    // 时间变化或首次 → 拉取并解析数据，重建图层
    setScreenStatus(props.screenId, '加载中…');
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
        setScreenElevations(props.screenId, []);
        grid = await fetchRadarGrid(file, product.id, signal);
      }
    } else {
      setScreenElevations(props.screenId, []);
      grid = await fetchRadarGrid(file, product.id, signal);
    }

    // 请求期间用户又切了时次 / 产品（或上传了文件）→ 本次结果作废
    if (token !== refreshToken) return;

    // 仰角列表写进 store：非空时屏头显示仰角选择器
    currentVolume = volume;
    layerElevation = volume ? sc.elevationIndex : -1;
    if (volume) setScreenElevations(props.screenId, volume.elevations);

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
    setScreenStatus(
      props.screenId,
      grid.isSynthetic ? '示意数据' : ''
    );
  } catch (e) {
    // 过期请求的失败同样不能影响当前屏的状态
    if (token !== refreshToken) return;
    // 主动取消（切时次/卸载）不是错误：保留当前画面，也不要弹“加载失败”
    if (e instanceof DOMException && e.name === 'AbortError') return;
    console.error('[RadarScreen] 渲染失败：', e);
    // 失败时保留旧画面会让用户误读成“该时次的数据”，因此一并清空
    clearLayer();
    // 404（模板模式时间轴时次未必有文件）→ 提示无数据；其余 → 加载失败
    setScreenStatus(props.screenId, e instanceof RadarFileMissingError ? '该时次无数据' : '加载失败');
  }
}

/**
 * 地图点击取值：把点击经纬度换算为最近格点，弹出该点数值与经纬度（保留三位小数）。
 * 无数据（网格外/缺测/低于显示阈值）时关闭已有弹窗。
 */
function onMapClick(e: L.LeafletMouseEvent): void {
  if (!map) return;
  const product = getProductByIdSafe(screen.value?.productId ?? 'Z');
  // 取值阈值必须与渲染口径一致：渲染层把低于阈值的格点画成透明，
  // 若不传阈值，点击无回波区会弹出数值（与图面自相矛盾）。
  const v = layerGrid
    ? sampleGridValue(
        layerGrid,
        e.latlng.lat,
        e.latlng.lng,
        firstVisibleThreshold(product),
        screen.value?.valueRange ?? null
      )
    : null;
  if (v === null) {
    map.closePopup();
    return;
  }
  L.popup({ closeButton: false, className: 'value-popup' })
    .setLatLng(e.latlng)
    .setContent(
      `${v.toFixed(1)} ${product.unit}<br>` +
      `${e.latlng.lat.toFixed(3)}°N, ${e.latlng.lng.toFixed(3)}°E`
    )
    .openOn(map as unknown as L.Map);
}

/**
 * 本屏上传雷达数据文件：读取 → 格式识别（mosaic/rstm/m4，见 radarApi.parseUploadedFile）
 * → 本屏渲染。识别成功/失败均用 ElMessage 提示，屏状态栏同步标记数据来源。
 * 上传数据仅作为本屏当前视图（记为当前时次：切产品/平滑走局部刷新），切换时次后恢复时间轴数据。
 */
async function onUploadChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // 允许重复选择同一文件
  if (!file || !map) return;
  const sc = screen.value;
  if (!sc) return;
  const product = getProductByIdSafe(sc.productId);
  // 上传与取数共用请求序号：识别期间若用户切换时次/产品，本次上传结果作废，
  // 避免几百毫秒后旧上传文件覆盖用户新选的时次画面。
  const token = ++refreshToken;
  try {
    setScreenStatus(props.screenId, '识别中…');
    const grid = await parseUploadedFile(file, sc.productId);
    if (token !== refreshToken) return;

    removeRadar(map, layer);
    layerGrid = grid;
    // 上传数据同样遵循本屏的色标范围（范围外渲染为透明）
    layer = renderRadar(map, grid, product, sc.smooth, sc.valueRange ?? null);
    layerTime = sc.time;
    layerProductId = product.id;
    layerThreshold = firstVisibleThreshold(product);
    layerSmooth = sc.smooth;
    layerRange = sc.valueRange ?? null;
    // 上传数据不是基数据体（parseUploadedFile 只支持 .bin/.m4），清除仰角维度
    currentVolume = null;
    layerElevation = -1;
    setScreenElevations(props.screenId, []);
    // 上传的数据区域可能与当前视野不同，重新定位到新数据范围
    fitToGrid(grid);
    setScreenStatus(props.screenId, '上传数据');
    ElMessage.success(`文件识别成功：${file.name}`);
  } catch (e) {
    // 过期上传的失败提示同样不应打扰当前操作
    if (token !== refreshToken) return;
    console.error('[RadarScreen] 上传文件识别失败：', e);
    setScreenStatus(props.screenId, '文件格式不符');
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
      //   复用屏（第 1 屏）受影响，新建屏因为挂载时尺寸已确定不受影响。
      layer?.reinit();
    });
  });
  mapResizeObserver.observe(el);

  refresh();
});

onBeforeUnmount(() => {
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
  unregisterMapLink(map!);
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
</script>

<template>
  <div class="radar-screen" :class="{ 'screen-active': isActive }" @click="setActiveScreen(screenId)">
    <!-- 屏头：序号 / 站点 / 产品 / 时间 / 状态 -->
    <div class="screen-header">
      <span>第 {{ screenId + 1 }} 屏</span>
      <span class="screen-info">
        {{ appState.products.find((p) => p.id === screen?.productId)?.name }}
        · {{ (screen?.time || '').replace('T', ' ').slice(5, 16) }}
      </span>
      <span v-if="status" class="screen-status">{{ status }}</span>
      <span v-if="isActive" class="active-dot">●</span>
      <!--
        仰角层选择（仅 RSTM 基数据体显示）：该格式一个文件含 9 个仰角层
        （0.5° ~ 19.5°），每层是独立的一次扫描，可按需切换查看。
        非基数据体（拼图 / m4 / 合成 RSTM）时 elevations 为空、选择器隐藏。
      -->
      <select
        v-if="screen?.elevations.length"
        class="screen-elev"
        :value="screen.elevationIndex"
        title="选择仰角层（RSTM 基数据 9 层）"
        @change="setScreenElevation(screenId, Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="(e, i) in screen.elevations" :key="i" :value="i">
          {{ e.toFixed(1) }}°
        </option>
      </select>
      <!-- 本屏平滑开关（每屏独立，便于多屏对比平滑效果） -->
      <label class="screen-smooth" title="平滑=双线性插值渲染；不平滑=格点填色（原始色块）">
        <input
          type="checkbox"
          :checked="screen?.smooth ?? false"
          @change="setScreenSmooth(screenId, ($event.target as HTMLInputElement).checked)"
        />
        平滑
      </label>
      <!-- 本屏数据上传（每屏独立）：识别预设格式（mosaic/rstm/m4）后在本屏渲染 -->
      <label
        class="btn screen-upload"
        title="上传雷达数据文件（支持 SWAN 拼图 / CINRAD RSTM / MICAPS m4）"
      >
        上传
        <input type="file" accept=".bin,.m4" hidden @change="onUploadChange" />
      </label>
    </div>
    <!-- 地图容器 + 色标浮层（固定在地图右下角，展示本屏产品色标） -->
    <div class="map-area">
      <div :id="mapElId" ref="elRef" class="map"></div>
      <Legend :screen-id="screenId" :product-id="screen?.productId ?? 'Z'" />
    </div>
  </div>
</template>
