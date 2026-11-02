<!--
  ProductList.vue —— 左侧产品列表

  功能：
    - 展示平台支持的产品目录（以反射率为首），标注实况/预报类型；
    - 点击产品 → 分配给【当前激活屏】，实现“不同屏显示不同产品”的对比；
    - 高亮激活屏当前使用的产品；每屏卡片上标注其产品与时间。
-->
<script setup lang="ts">
import { computed } from 'vue';
import {
  appState,
  activeScreen,
  getProductByIdSafe,
  setScreenProduct,
  setActiveScreen
} from '../store/appStore';
// 时间短文本统一走 utils/datetime，禁止在组件里手写 replace/slice
import { formatShortTime } from '../utils/datetime';

/** 激活屏当前的产品代码（用于高亮）；统一从 activeScreen 取，不直接索引数组 */
const activeProductId = computed(() => activeScreen.value?.productId ?? '');

/** 激活屏的展示序号（按数组位置，不假设 id === 下标） */
const activeScreenIndex = computed(() => {
  const i = appState.screens.findIndex((s) => s.id === appState.activeScreenId);
  return i >= 0 ? i + 1 : 1;
});
</script>

<template>
  <aside class="product-panel">
    <div class="panel-title">
      产品列表
      <span class="panel-sub">作用于第 {{ activeScreenIndex }} 屏</span>
    </div>

    <!-- 产品按钮列表 -->
    <ul class="product-list">
      <li v-for="p in appState.products" :key="p.id">
        <button
          class="product-item"
          :class="{ 'item-active': p.id === activeProductId }"
          :title="p.name"
          @click="
            setScreenProduct(appState.activeScreenId, p.id);
            setActiveScreen(appState.activeScreenId);
          "
        >
          <span class="product-name">{{ p.name }}</span>
          <span class="product-type" :class="{ 'type-fcst': p.type === 'fcst' }">
            {{ p.type === 'fcst' ? '预报' : '实况' }}
          </span>
          <!-- 名称里已括注单位时（如「反射率（dBZ）」）不再重复显示单位 -->
          <span class="product-unit" v-if="!p.name.includes(`（${p.unit}）`)">
            {{ p.unit }}
          </span>
        </button>
      </li>
    </ul>

    <!-- 各屏配置概览（点击可切换激活屏） -->
    <div class="screen-overview">
      <div class="panel-title">各屏状态</div>
      <button
        v-for="(s, i) in appState.screens"
        :key="s.id"
        class="screen-card"
        :class="{ 'item-active': s.id === appState.activeScreenId }"
        @click="setActiveScreen(s.id)"
      >
        第 {{ i + 1 }} 屏 ·
        {{ getProductByIdSafe(s.productId).name }}
        <span class="screen-time">{{ formatShortTime(s.time) }}</span>
      </button>
    </div>
  </aside>
</template>
