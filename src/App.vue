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
  setFiles,
  setTimeline,
  setTimelineConfig
} from './store/appStore';
import { fetchProductList } from './api/productApi';
import { fetchRadarFileList } from './api/radarApi';
import { fetchAppConfig, buildTimelineTimes } from './api/configApi';

/** 网格布局 class：决定多屏排列方式 */
const gridClass = () => `grid-${appState.layout}`;

/* —— 应用启动：拉取产品目录；配置模式生成时间轴，无配置回退清单模式 —— */
onMounted(async () => {
  try {
    const [products, config] = await Promise.all([fetchProductList(), fetchAppConfig()]);
    setProducts(products);
    if (config) {
      // 配置模式：时间轴按规则提前生成（与文件无关）；
      // 有模板 → 文件路径按时刻构造；无模板 → 仍用清单按时间匹配
      setTimelineConfig(config);
      setTimeline(buildTimelineTimes(config), config.fileUrlTemplate);
      if (!config.fileUrlTemplate) {
        setFiles(await fetchRadarFileList(config.fileListUrl));
      }
    } else {
      // 回退：无配置文件 → 时间轴取自清单文件时刻（本地 demo 行为）
      setFiles(await fetchRadarFileList());
    }
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
