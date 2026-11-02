<!--
  RadarScreen.vue —— 单屏容器（布局与子组件组合）

  具体职责已拆分：
    - composables/useRadarScreen.ts：地图生命周期 / 取数 / 图层状态机 / 取样 / 上传；
    - ScreenHeader.vue：屏头状态、仰角、平滑、上传入口；
    - CoordinateQuery.vue：坐标查询面板（取样由父组件传入）；
    - Legend.vue：色标与范围选择。
-->
<script setup lang="ts">
import { setActiveScreen } from '../store/appStore';
import { useRadarScreen } from '../composables/useRadarScreen';
import ScreenHeader from './ScreenHeader.vue';
import CoordinateQuery from './CoordinateQuery.vue';
import Legend from './Legend.vue';

/** 组件入参：屏的稳定 id */
const props = defineProps<{ screenId: number }>();

const { elRef, mapElId, isActive, productId, showValueAt, onUpload } = useRadarScreen(
  props.screenId
);
</script>

<template>
  <div
    class="radar-screen"
    :class="{ 'screen-active': isActive }"
    @click="setActiveScreen(screenId)"
  >
    <ScreenHeader :screen-id="screenId" @upload="onUpload" />

    <!-- 地图容器 + 色标浮层（右下角）+ 坐标查询浮层（左下角，两者互不干扰） -->
    <div class="map-area">
      <div :id="mapElId" ref="elRef" class="map"></div>
      <Legend :screen-id="screenId" :product-id="productId" />
      <CoordinateQuery :sample="showValueAt" />
    </div>
  </div>
</template>
