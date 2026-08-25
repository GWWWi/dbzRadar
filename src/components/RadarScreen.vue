<!--
  RadarScreen.vue —— 单块雷达屏（渲染容器）

  职责：
    - onMounted：创建 QuickEarth 地图 + 叠加天地图底图；
    - watch 本屏 productId / time / smooth：变化时通过 radarApi 取数并渲染
      （时间变 → 数据变 → 重建图层；仅产品/平滑变 → 局部刷新绘制选项）；
    - 屏头平滑开关：每屏独立切换色斑图平滑/不平滑（多屏对比用）；
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
  setActiveScreen
} from '../store/appStore';
import { createRadarMap, addTiandituBase, registerMapLink, unregisterMapLink } from '../render/mapManager';
import { renderRadar, updateRadarProduct, updateRadarSmooth, removeRadar, firstVisibleThreshold, sampleGridValue } from '../render/radarRenderer';
import { fetchRadarGrid, buildFileMetaFromTemplate, RadarFileMissingError } from '../api/radarApi';
import Legend from './Legend.vue';
import * as L from 'leaflet';
import type { LMap } from '@quickearth/leaflet';
import type { LPixelLayer } from '@quickearth/leaflet';
import type { RadarGrid } from '../types';

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

const isActive = computed(() => appState.activeScreenId === props.screenId);
const status = computed(() => appState.screens[props.screenId]?.status ?? '');

/**
 * 取数 + 渲染。
 * 依据本屏的 time 找到清单文件 → fetchRadarGrid → renderRadar。
 */
async function refresh(): Promise<void> {
  const sc = appState.screens[props.screenId];
  if (!sc || !map) return;

  const product = getProductByIdSafe(sc.productId);
  if (!product || !sc.time) return;
  // 文件路径解析：模板模式按时刻构造地址（404 → 提示无数据）；
  // 清单模式按时间在清单中精确匹配，清单无此时次 → 提示无数据
  const file = appState.fileUrlTemplate
    ? buildFileMetaFromTemplate(appState.fileUrlTemplate, sc.time)
    : (appState.files.find((f) => f.time === sc.time) ?? null);
  if (!file) {
    setScreenStatus(props.screenId, '该时次无数据');
    return;
  }

  // 完全没变化 → 跳过
  if (layer && layerTime === sc.time && layerProductId === product.id && layerSmooth === sc.smooth) return;

  try {
    // 时间未变 → 局部更新（产品色标 / 平滑模式），不重建图层
    if (layer && layerGrid && layerTime === sc.time) {
      if (layerProductId !== product.id) {
        updateRadarProduct(layer, layerGrid, layerThreshold, product, sc.smooth);
        layerProductId = product.id;
        layerThreshold = firstVisibleThreshold(product);
      } else if (layerSmooth !== sc.smooth) {
        updateRadarSmooth(layer, product, sc.smooth);
      }
      layerSmooth = sc.smooth;
      return;
    }

    // 时间变化或首次 → 拉取并解析数据，重建图层
    setScreenStatus(props.screenId, '加载中…');
    const grid = await fetchRadarGrid(file, product.id);

    removeRadar(map, layer);
    layerGrid = grid;
    layer = renderRadar(map, grid, product, sc.smooth);
    layerTime = grid.time;
    layerProductId = product.id;
    layerThreshold = firstVisibleThreshold(product);
    layerSmooth = sc.smooth;
    setScreenStatus(
      props.screenId,
      grid.isSynthetic ? '示意数据' : ''
    );
  } catch (e) {
    console.error('[RadarScreen] 渲染失败：', e);
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
  const product = getProductByIdSafe(appState.screens[props.screenId]?.productId ?? 'Z');
  const v = layerGrid ? sampleGridValue(layerGrid, e.latlng.lat, e.latlng.lng) : null;
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

onMounted(() => {
  if (!elRef.value) return; // 容器未就绪（极端时序），跳过
  map = createRadarMap(elRef.value);
  addTiandituBase(map); // 天地图矢量底图 + 注记
  registerMapLink(map); // 纳入多屏地图联动（缩放/平移同步）
  map.on('click', onMapClick);
  refresh();
});

onBeforeUnmount(() => {
  removeRadar(map, layer);
  unregisterMapLink(map!);
  if (map && typeof map.remove === 'function') map.remove();
  map = null;
  layer = null;
});

// 本屏 产品/时间/平滑开关 变化 → 自动重渲染
watch(
  () => {
    const s = appState.screens[props.screenId];
    return s ? s.productId + '|' + s.time + '|' + (s.smooth ? 1 : 0) : '';
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
        {{ appState.products.find((p) => p.id === appState.screens[screenId]?.productId)?.name }}
        · {{ (appState.screens[screenId]?.time || '').replace('T', ' ').slice(5, 16) }}
      </span>
      <span v-if="status" class="screen-status">{{ status }}</span>
      <span v-if="isActive" class="active-dot">●</span>
      <!-- 本屏平滑开关（每屏独立，便于多屏对比平滑效果） -->
      <label class="screen-smooth" title="平滑=双线性插值渲染；不平滑=格点填色（原始色块）">
        <input
          type="checkbox"
          :checked="appState.screens[screenId]?.smooth ?? false"
          @change="setScreenSmooth(screenId, ($event.target as HTMLInputElement).checked)"
        />
        平滑
      </label>
    </div>
    <!-- 地图容器 + 色标浮层（固定在地图右下角，展示本屏产品色标） -->
    <div class="map-area">
      <div :id="mapElId" ref="elRef" class="map"></div>
      <Legend :product-id="appState.screens[screenId]?.productId ?? 'Z'" />
    </div>
  </div>
</template>
