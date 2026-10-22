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
import { ElMessage } from 'element-plus';
import Toolbar from './components/Toolbar.vue';
import ProductList from './components/ProductList.vue';
import RadarScreen from './components/RadarScreen.vue';
import Timeline from './components/Timeline.vue';
import {
  appState,
  activeScreen,
  timelineTimes,
  setScreenTime,
  setProducts,
  setFiles,
  setTimeline,
  setTimelineConfig
} from './store/appStore';
import { fetchProductList } from './api/productApi';
import { fetchRadarFileList } from './api/radarApi';
import { fetchAppConfig, buildTimelineTimes, fetchLatestTime, snapNearestTime } from './api/configApi';

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
    // 获取当前产品最新时间（假数据接口）→ 吸附到时间轴最近时次，
    // 赋值到时间轴与时间选择控件（setScreenTime 经 jumpValue watch 同步控件）
    const latest = await fetchLatestTime(activeScreen.value?.productId ?? 'dBZ');
    const snapped = snapNearestTime(timelineTimes.value, latest);
    if (snapped) setScreenTime(appState.activeScreenId, snapped);
  } catch (e) {
    console.error('[App] 初始化数据加载失败：', e);
    // 初始化失败必须有可见反馈：否则页面只是空产品列表 + 空时间轴，
    // 用户无法判断是“没有数据”还是“服务不可用”。
    // 注意：产品目录内部已有静态回退，这里通常捕获的是清单/配置请求失败。
    ElMessage.error(
      e instanceof Error ? e.message : '应用初始化失败，请检查数据服务是否可用'
    );
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
        // 上一时次仍在加载时不推进：避免 800ms 内堆积多个请求/解析任务
        // （缓存命中时通常一帧内完成，不会影响正常播放节奏）
        if (appState.screens.some((s) => s.status === '加载中…')) return;
        // 取当前屏时间在时间轴上的下一个时次（到尾则回头）
        const cur = times.indexOf(activeScreen.value.time);
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
