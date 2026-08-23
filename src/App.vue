<!--
  App.vue —— 根组件：整体布局编排

  布局结构：
    ┌────────────────────────────────────┐
    │ Toolbar（布局切换 / 同步 / 播放）      │
    ├──────┬─────────────────────────────┤
    │ 产品  │  多屏网格（1/2/4/6 屏）        │
    │ 列表  │  每屏一张独立地图（不同产品）     │
    │ 图例  │                             │
    ├──────┴─────────────────────────────┤
    │ Timeline（时间轴，作用于激活屏/全部屏） │
    └────────────────────────────────────┘

  播放定时器也在这里：playing=true 时每 800ms 推进激活屏一个时次
  （syncPlay 开启时 appStore 会自动广播到所有屏）。
-->
<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue';
import Toolbar from './components/Toolbar.vue';
import ProductList from './components/ProductList.vue';
import RadarScreen from './components/RadarScreen.vue';
import Timeline from './components/Timeline.vue';
import {
  appState,
  timelineTimes,
  setScreenTime,
  setProducts,
  setFiles
} from './store/appStore';
import { fetchProductList } from './api/productApi';
import { fetchRadarFileList } from './api/radarApi';

/** 网格布局 class：决定多屏排列方式 */
const gridClass = () => `grid-${appState.layout}`;

/* —— 应用启动：并行拉取产品目录与雷达文件清单 —— */
onMounted(async () => {
  try {
    const [products, files] = await Promise.all([
      fetchProductList(),
      fetchRadarFileList()
    ]);
    setProducts(products);
    setFiles(files); // 同时给各屏填入首个时次
  } catch (e) {
    console.error('[App] 初始化数据加载失败：', e);
  }
});

/* —— 播放动画：每 800ms 推进一个时次（循环） —— */
let timer: number | undefined;
watch(
  () => appState.playing,
  (playing) => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (playing) {
      timer = window.setInterval(() => {
        const times = timelineTimes.value;
        if (times.length === 0) return;
        // 取当前屏时间在时间轴上的下一个时次（到尾则回头）
        const cur = times.indexOf(appState.screens[appState.activeScreenId].time);
        const next = times[(cur + 1 + times.length) % times.length];
        setScreenTime(appState.activeScreenId, next);
      }, 800);
    }
  }
);

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="app">
    <Toolbar />

    <div class="main-area">
      <!-- 左侧：产品列表 -->
      <div class="side-panel">
        <ProductList />
      </div>

      <!-- 右侧：多屏网格 -->
      <div :class="['screen-grid', gridClass()]">
        <RadarScreen v-for="s in appState.screens" :key="s.id" :screen-id="s.id" />
      </div>
    </div>

    <Timeline />
  </div>
</template>
