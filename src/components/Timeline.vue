<!--
  Timeline.vue —— 底部时间轴

  功能：
    - 依据时间轴时刻（配置模式生成 / 清单回退模式取文件时刻）渲染刻度轴；
    - TimeAxis（canvas 刻度轴）：拖拽平移 / 点击跳转 / 滚轮缩放，
      吸附到最近时次；顶条绿色刻度标记“有文件”的时次；
    - 配置模式下提供时间选择控件：
        预报模式选“起报时间”（时间轴起点）、实况模式选“结束时间”（时间轴终点），
        改选后以该时刻为锚点重新生成时间轴并跳转；
    - 时间选择框：下拉列出全部时次快速跳转
      （显示格式 YYYY-MM-DD HH:mm，option 值 YYYYMMDDHHmm）；
    - 上一个 / 下一步按钮逐时次步进；播放由 App 的定时器驱动。
-->
<script setup lang="ts">
import { computed } from 'vue';
import {
  appState,
  activeScreen,
  timelineTimes,
  setScreenTime,
  setTimeline
} from '../store/appStore';
import { buildTimelineTimes } from '../api/configApi';
import TimeAxis from './TimeAxis.vue';

/** 当前激活屏时刻在时间轴上的索引（决定步进位置） */
const currentIndex = computed(() => {
  const t = activeScreen.value?.time;
  const idx = timelineTimes.value.indexOf(t ?? '');
  return idx >= 0 ? idx : 0;
});

/** 有文件的时次（刻度轴顶条绿色标记）；模板模式无法预知，为空数组 */
const fileTimes = computed(() => appState.files.map((f) => f.time));

/** 刻度轴拖拽/点击 → 设置激活屏时刻（syncPlay 时广播全屏） */
function onAxisChange(time: string): void {
  setScreenTime(appState.activeScreenId, time);
}

/** 是否配置模式（清单回退模式无生成规则，隐藏时间选择控件） */
const isConfigMode = computed(() => !!appState.timelineConfig);

/** 时间选择控件标签：预报模式=起报时间（轴起点），实况模式=结束时间（轴终点） */
const pickLabel = computed(() =>
  appState.timelineConfig?.timeline.mode === 'fcst' ? '起报时间' : '结束时间'
);

/** 控件当前值（datetime-local 格式 yyyy-MM-ddTHH:mm）：预报取首时次，实况取末时次 */
const pickValue = computed(() => {
  const times = timelineTimes.value;
  if (!times.length) return '';
  const anchor =
    appState.timelineConfig?.timeline.mode === 'fcst' ? times[0] : times[times.length - 1];
  return anchor.slice(0, 16);
});

/** 时间格式化：'2022-06-19T00:00:43' → '06-19 00:00:43' */
const fmt = (t?: string) => (t ? t.replace('T', ' ').slice(5, 19) : '--');

/** 时间选择框选项：显示 YYYY-MM-DD HH:mm，value 为紧凑串 YYYYMMDDHHmm */
const timeOptions = computed(() =>
  timelineTimes.value.map((t) => ({
    value: t.replace(/[-:T]/g, '').slice(0, 12),
    label: t.replace('T', ' ').slice(0, 16)
  }))
);

/** 时间选择框当前值：激活屏时刻的紧凑串（不在时间轴上时为空串 → 框内空白） */
const selectValue = computed(() =>
  (activeScreen.value?.time ?? '').replace(/[-:T]/g, '').slice(0, 12)
);

/** 时间选择框跳转：value YYYYMMDDHHmm → 时间轴时刻（秒固定 00），syncPlay 时广播全屏 */
function onSelectTime(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v.length !== 12) return;
  const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:00`;
  if (timelineTimes.value.includes(iso)) setScreenTime(appState.activeScreenId, iso);
}

/** 步进：delta = ±1 */
function step(delta: number): void {
  const times = timelineTimes.value;
  const next = Math.min(Math.max(currentIndex.value + delta, 0), times.length - 1);
  if (times[next]) setScreenTime(appState.activeScreenId, times[next]);
}

/**
 * 选择起报/结束时间：以所选时刻为锚点重新生成时间轴，
 * 并把屏跳到锚点时次（syncPlay 开启时广播全部屏）。
 */
function onPickAnchor(e: Event): void {
  const cfg = appState.timelineConfig;
  const v = (e.target as HTMLInputElement).value;
  if (!cfg || !v) return;
  const anchorMs = new Date(v).getTime();
  if (!Number.isFinite(anchorMs)) return;
  setTimeline(buildTimelineTimes(cfg, anchorMs), appState.fileUrlTemplate);
  setScreenTime(appState.activeScreenId, v + ':00');
}

defineExpose({ step });
</script>

<template>
  <footer class="timeline">
    <button class="btn" title="上一时次" @click="step(-1)">◀</button>

    <!-- Canvas 刻度轴：拖拽平移 / 点击跳转 / 滚轮缩放，吸附最近时次 -->
    <TimeAxis
      :times="timelineTimes"
      :current="activeScreen?.time ?? ''"
      :marks="fileTimes"
      @change="onAxisChange"
    />

    <button class="btn" title="下一时次" @click="step(1)">▶</button>

    <!-- 时间选择控件（仅配置模式）：选预报起报时间 / 实况结束时间 -->
    <template v-if="isConfigMode">
      <span class="timeline-pick-label">{{ pickLabel }}</span>
      <input
        class="timeline-dt"
        type="datetime-local"
        title="预报模式为起报时间，实况模式为结束时间"
        :value="pickValue"
        @change="onPickAnchor"
      />
    </template>

    <!-- 时间选择框：快速跳转时次（显示 YYYY-MM-DD HH:mm，值 YYYYMMDDHHmm） -->
    <select
      class="timeline-select"
      title="选择时次"
      :value="selectValue"
      @change="onSelectTime"
    >
      <option v-for="o in timeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>

    <span class="timeline-time">{{ fmt(activeScreen?.time) }}</span>
    <span class="timeline-count">{{ currentIndex + 1 }} / {{ timelineTimes.length }} 时次</span>
  </footer>
</template>
