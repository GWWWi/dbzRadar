<!--
  Timeline.vue —— 底部时间轴

  功能：
    - 依据清单中所有文件时刻渲染滑块与刻度点；
    - 拖动/点击 → 把对应时刻设置给当前激活屏
      （开启“多屏同步”时自动广播到所有屏，见 appStore.setScreenTime）；
    - 上一个 / 下一步按钮逐时次步进；播放由 App 的定时器驱动。
-->
<script setup lang="ts">
import { computed } from 'vue';
import { appState, activeScreen, timelineTimes, setScreenTime } from '../store/appStore';

/** 当前激活屏时刻在时间轴上的索引（决定滑块位置） */
const currentIndex = computed(() => {
  const t = activeScreen.value?.time;
  const idx = timelineTimes.value.indexOf(t ?? '');
  return idx >= 0 ? idx : 0;
});

/** 时间格式化：'2022-06-19T00:00:43' → '06-19 00:00:43' */
const fmt = (t?: string) => (t ? t.replace('T', ' ').slice(5, 19) : '--');

/** 滑块拖动 */
function onSeek(e: Event): void {
  const idx = Number((e.target as HTMLInputElement).value);
  const time = timelineTimes.value[idx];
  if (time) setScreenTime(appState.activeScreenId, time);
}

/** 步进：delta = ±1 */
function step(delta: number): void {
  const times = timelineTimes.value;
  const next = Math.min(Math.max(currentIndex.value + delta, 0), times.length - 1);
  if (times[next]) setScreenTime(appState.activeScreenId, times[next]);
}

defineExpose({ step });
</script>

<template>
  <footer class="timeline">
    <button class="btn" title="上一时次" @click="step(-1)">◀</button>

    <!-- 滑块：索引即时刻 -->
    <input
      class="timeline-range"
      type="range"
      min="0"
      :max="Math.max(timelineTimes.length - 1, 0)"
      :value="currentIndex"
      @input="onSeek"
    />

    <button class="btn" title="下一时次" @click="step(1)">▶</button>

    <span class="timeline-time">{{ fmt(activeScreen?.time) }}</span>
    <span class="timeline-count">{{ currentIndex + 1 }} / {{ timelineTimes.length }} 时次</span>
  </footer>
</template>
