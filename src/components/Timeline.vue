<!--
  Timeline.vue —— 底部时间轴

  功能：
    - 依据时间轴时刻（配置模式生成 / 清单回退模式取文件时刻）渲染刻度轴；
    - TimeAxis（canvas 刻度轴）：拖拽平移 / 点击跳转 / 滚轮缩放，
      拖拽时视图自由平移、选中时次吸附最近可用时刻；顶条绿色刻度标记“有文件”的时次；
    - 锚点时间选择（Element Plus el-date-picker，仅配置模式）：
        预报模式选“起报时间”（时间轴起点）、实况模式选“结束时间”（时间轴终点），
        改选后以该时刻为锚点重新生成时间轴并跳转；
    - 时间选择控件（Element Plus el-date-picker）：跳转时次
      （显示格式 YYYY-MM-DD HH:mm，值 YYYYMMDDHHmm，不吸附）；
    - 上一个 / 下一步按钮逐时次步进；播放由 App 的定时器驱动。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElDatePicker } from 'element-plus';
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

/**
 * 锚点时间控件绑定值（紧凑串 YYYYMMDDHHmm）。
 * ★ 必须用 v-model（本地 ref）而非只读 :model-value：
 *   受控单向绑定时面板内部状态会被 prop 重置，导致点击日期无响应。
 *   预报取首时次（起报），实况取末时次（结束）。
 */
const anchorValue = ref('');
watch(
  [() => appState.timelineConfig?.timeline.mode, timelineTimes],
  () => {
    const times = timelineTimes.value;
    if (!times.length) {
      anchorValue.value = '';
      return;
    }
    const anchor =
      appState.timelineConfig?.timeline.mode === 'fcst' ? times[0] : times[times.length - 1];
    anchorValue.value = anchor.replace(/[-:T]/g, '').slice(0, 12);
  },
  { immediate: true }
);

/** 时间格式化：'2022-06-19T00:00:43' → '06-19 00:00:43' */
const fmt = (t?: string) => (t ? t.replace('T', ' ').slice(5, 19) : '--');

/**
 * 跳转时间控件绑定值（紧凑串 YYYYMMDDHHmm，随激活屏时刻同步）。
 * 同样必须 v-model（原因同上）。
 */
const jumpValue = ref('');
watch(
  () => activeScreen.value?.time ?? '',
  (t) => {
    jumpValue.value = t ? t.replace(/[-:T]/g, '').slice(0, 12) : '';
  },
  { immediate: true }
);

/**
 * 时间选择控件跳转：value YYYYMMDDHHmm → ISO（秒固定 00）。
 * 不做吸附：直接设置所选时刻，由 RadarScreen 查找对应文件，
 * 不存在时提示“该时次无数据”。
 */
function onSelectTime(v: string): void {
  if (!v || v.length !== 12) return;
  const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:00`;
  setScreenTime(appState.activeScreenId, iso);
}

/** 步进：delta = ±1 */
function step(delta: number): void {
  const times = timelineTimes.value;
  const next = Math.min(Math.max(currentIndex.value + delta, 0), times.length - 1);
  if (times[next]) setScreenTime(appState.activeScreenId, times[next]);
}

/**
 * 选择起报/结束时间（Element Plus 日期时间控件，value-format 为
 * YYYYMMDDHHmm）：以所选时刻为锚点重新生成时间轴，
 * 并把屏跳到锚点时次（syncPlay 开启时广播全部屏）。
 */
function onPickAnchor(v: string): void {
  const cfg = appState.timelineConfig;
  if (!cfg || !v || v.length !== 12) return;
  const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:00`;
  setTimeline(buildTimelineTimes(cfg, new Date(iso).getTime()), appState.fileUrlTemplate);
  setScreenTime(appState.activeScreenId, iso);
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

    <!-- 锚点时间选择（Element Plus，仅配置模式）：预报选起报时间 / 实况选结束时间 -->
    <template v-if="isConfigMode">
      <span class="timeline-pick-label">{{ pickLabel }}</span>
      <el-date-picker
        v-model="anchorValue"
        class="timeline-dt"
        type="datetime"
        title="预报模式为起报时间，实况模式为结束时间"
        format="YYYY-MM-DD HH:mm"
        value-format="YYYYMMDDHHmm"
        :clearable="false"
        @change="onPickAnchor"
      />
    </template>

    <!-- 时间选择控件（Element Plus）：跳转时次（显示 YYYY-MM-DD HH:mm，值 YYYYMMDDHHmm，不吸附） -->
    <el-date-picker
      v-model="jumpValue"
      class="timeline-jump"
      type="datetime"
      title="选择时次"
      format="YYYY-MM-DD HH:mm"
      value-format="YYYYMMDDHHmm"
      :clearable="false"
      @change="onSelectTime"
    />

    <span class="timeline-time">{{ fmt(activeScreen?.time) }}</span>
    <span class="timeline-count">{{ currentIndex + 1 }} / {{ timelineTimes.length }} 时次</span>
  </footer>
</template>
