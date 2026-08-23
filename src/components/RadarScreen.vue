<!--
  RadarScreen.vue —— 单块雷达屏（渲染容器）

  职责：
    - onMounted：创建 QuickEarth 地图 + 叠加天地图底图；
    - watch 本屏 productId / time：变化时通过 radarApi 取数并渲染
      （时间变 → 数据变 → 重建图层；仅产品变 → 只刷新色标）；
    - 点击屏体 → 设为激活屏；
    - onBeforeUnmount：销毁地图，防止内存泄漏与重复初始化报错。
-->
<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, ref, computed } from 'vue';
import {
  appState,
  getProductByIdSafe,
  setScreenStatus,
  setActiveScreen
} from '../store/appStore';
import { createRadarMap, addTiandituBase } from '../render/mapManager';
import { renderRadar, updateRadarProduct, removeRadar, firstVisibleThreshold } from '../render/radarRenderer';
import { fetchRadarGrid } from '../api/radarApi';
import Legend from './Legend.vue';
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
  const file = appState.files.find((f) => f.time === sc.time);
  if (!product || !file) return;

  // 完全没变化 → 跳过
  if (layer && layerTime === sc.time && layerProductId === product.id) return;

  try {
    // 仅产品变化（时间未变）→ 局部更新色标/阈值即可
    if (layer && layerGrid && layerTime === sc.time && layerProductId !== product.id) {
      updateRadarProduct(layer, layerGrid, layerThreshold, product);
      layerProductId = product.id;
      layerThreshold = firstVisibleThreshold(product);
      return;
    }

    // 时间变化或首次 → 拉取并解析数据，重建图层
    setScreenStatus(props.screenId, '加载中…');
    const grid = await fetchRadarGrid(file, product.id);

    removeRadar(map, layer);
    layerGrid = grid;
    layer = renderRadar(map, grid, product);
    layerTime = grid.time;
    layerProductId = product.id;
    layerThreshold = firstVisibleThreshold(product);
    setScreenStatus(
      props.screenId,
      grid.isSynthetic ? '示意数据' : ''
    );
  } catch (e) {
    console.error('[RadarScreen] 渲染失败：', e);
    setScreenStatus(props.screenId, '加载失败');
  }
}

onMounted(() => {
  if (!elRef.value) return; // 容器未就绪（极端时序），跳过
  map = createRadarMap(elRef.value);
  addTiandituBase(map); // 天地图矢量底图 + 注记
  refresh();
});

onBeforeUnmount(() => {
  removeRadar(map, layer);
  if (map && typeof map.remove === 'function') map.remove();
  map = null;
  layer = null;
});

// 本屏 产品/时间 变化 → 自动重渲染
watch(
  () => {
    const s = appState.screens[props.screenId];
    return s ? s.productId + '|' + s.time : '';
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
    </div>
    <!-- 地图容器 + 色标浮层（固定在地图右下角，展示本屏产品色标） -->
    <div class="map-area">
      <div :id="mapElId" ref="elRef" class="map"></div>
      <Legend :product-id="appState.screens[screenId]?.productId ?? 'Z'" />
    </div>
  </div>
</template>
