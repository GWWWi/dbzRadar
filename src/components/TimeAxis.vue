<!--
  TimeAxis.vue —— Canvas 绘制的时间轴（视觉与交互参考 timeline-canvas 项目）

  视觉：
    - 深色背景 + 顶部刻度条（scaleBar）；
    - 刻度线（间隔随可见跨度自适应，跨零点标注日期）；
    - 中央绿色指示线 + 当前时间；悬停灰色线 + 指针处时间；
    - 顶条上以绿色小刻度标记“有文件”的时次（marks）。
  交互：
    - 拖拽左右任意平移视图（不吸附、不触发取文件）；
    - 松手后吸附到最近的可用时次并通知父组件加载对应时间的文件；
    - 点击任意位置 → 跳转到该处最近时次；
    - 滚轮缩放可见时间跨度（1h ~ 时间轴总跨度）。

  受控组件：自身不保存当前时间，拖拽/点击吸附后 emit('change')，
  由父组件写回 store 再经 props 更新，保证单一数据源。
-->
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed, nextTick } from 'vue';
// 时间换算统一走 utils/datetime（与时间轴生成、文件模板保持同一格式源）
import { isoToMs, msToISO, msToText, pad2 } from '../utils/datetime';

const props = defineProps<{
  /** 时间轴全部时刻（ISO 串，升序） */
  times: string[];
  /** 当前时刻（中央指示线，ISO 串；空串时以当前系统时间居中显示） */
  current: string;
  /** 有文件的时刻标记（顶条绿色刻度）；模板模式无法预知，传空数组 */
  marks?: string[];
}>();

const emit = defineEmits<{ (e: 'change', time: string): void }>();

/** 画布高度（px） */
const HEIGHT = 60;
/** 配色（参考 timeline-canvas 默认色，背景融入平台深色主题） */
const COLORS = {
  background: '#1a2330',
  meddleLine: '#33CC33',
  moveLine: '#808080',
  moveDate: '#009966',
  scaleLine: '#808080',
  scaleBar: '#45484c'
};

const canvasRef = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let cssWidth = 0;
let dpr = 1;
let resizeObserver: ResizeObserver | null = null;

/** 可见时间跨度（小时），滚轮缩放 */
let spanHours = 24;
/** 悬停指针 x（null=指针不在轴上） */
let hoverX: number | null = null;
/**
 * 拖拽中的视图中心（ms）。拖拽时视图自由平移（不吸附、不触发取文件），
 * 松手后吸附最近时次并 emit；null=非拖拽，视图跟随 current。
 * 若直接用吸附后的 current 做视图中心，时次稀疏时拖动会显得完全不动。
 */
let viewMs: number | null = null;
/** 拖拽状态：按下位置/按下时中心时刻/是否发生过移动 */
let dragging = false;
let dragMoved = false;
let downX = 0;
let downMs = 0;

/**
 * 画布内部选时的 emit 标记：
 * true 时 currentMs 变化不重置视图（视图停在拖动位置）；
 * 外部跳转（下拉/步进/播放/锚点）时视图重新居中。
 */
let emitGuard = false;

/** times/marks 的毫秒缓存（props 变化时重算） */
let timesMs: number[] = [];
let marksMs: number[] = [];

/* ─────────────── 时间换算工具 ─────────────── */
/*
 * 本组件不再自带 ISO 生成/解析实现：
 *   - isoToMs  ：ISO → 毫秒（缓存 times/marks、计算当前时刻）
 *   - msToISO  ：毫秒 → ISO（吸附后 emit 给父组件）
 *   - msToText ：毫秒 → 画布文字（悬停到分钟 / 当前时刻到秒）
 *   - pad2     ：刻度文字补零
 */

/** 当前中心时刻（ms） */
const currentMs = computed(() =>
  props.current ? isoToMs(props.current) : Math.floor(Date.now() / 60000) * 60000
);

/** 可缩放的最大跨度（小时）：时间轴总跨度向上取 4 的倍数，且不小于 24 */
const maxSpanHours = computed(() => {
  if (timesMs.length < 2) return 24;
  const span = (timesMs[timesMs.length - 1] - timesMs[0]) / 3600000;
  return Math.max(24, Math.ceil(span / 4) * 4);
});

/** 每像素对应毫秒数 */
/** 画布左右留白（px）：刻度与文字不贴边，边缘标注不被裁切 */
const PAD_X = 10;

function msPerPx(): number {
  return (spanHours * 3600000) / Math.max(1, cssWidth - PAD_X * 2);
}

/**
 * 返回第一个 >= target 的下标（要求 arr 升序）。
 * 用于把“可见时间区间”映射到 marks 下标，避免每帧遍历上万条标记。
 */
function lowerBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 吸附到最近的可用时次（二分查找） */
function snapToTimes(ms: number): number {
  const arr = timesMs;
  if (!arr.length) return ms;
  if (ms <= arr[0]) return arr[0];
  if (ms >= arr[arr.length - 1]) return arr[arr.length - 1];
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  // arr[lo] 为第一个 >= ms 的时刻，与前一档比较取更近者
  if (lo > 0 && ms - arr[lo - 1] <= arr[lo] - ms) return arr[lo - 1];
  return arr[lo];
}

/** 刻度间隔（毫秒）：从候选档中取首个使相邻刻度 ≥ 60px 的档位 */
function tickMs(): number {
  const candidates = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360, 720, 1440]; // 分钟
  const needMin = (60 * msPerPx()) / 60000;
  for (const c of candidates) if (c >= needMin) return c * 60000;
  const days = Math.ceil(needMin / 1440);
  return days * 86400000;
}

/* ─────────────── 绘制 ─────────────── */
function draw(): void {
  const canvas = canvasRef.value;
  if (!canvas || !ctx || cssWidth <= 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, cssWidth, HEIGHT);
  // 顶部刻度条
  ctx.fillStyle = COLORS.scaleBar;
  ctx.fillRect(0, 0, cssWidth, 20);

  const mpp = msPerPx();
  const center = viewMs ?? currentMs.value;
  // firstMs 使 center 恰好映射到画布水平中点（两侧各留 PAD_X）
  const firstMs = center - (spanHours * 3600000) / 2;
  const lastMs = center + (spanHours * 3600000) / 2;
  const xFor = (ms: number): number => PAD_X + (ms - firstMs) / mpp;
  const msAt = (x: number): number => firstMs + (x - PAD_X) * mpp;

  // 有文件的时次标记（顶条绿色小刻度）
  // marksMs 已升序：二分定位可见区间起点，只绘制可见标记后即 break。
  // 配置失误时 marks 可能上万条，全量遍历会拖慢每一帧。
  ctx.fillStyle = COLORS.meddleLine;
  for (let i = lowerBound(marksMs, firstMs); i < marksMs.length; i++) {
    const ms = marksMs[i];
    if (ms > lastMs) break;
    ctx.fillRect(xFor(ms) - 1, 0, 2, 20);
  }

  // 刻度线与标注（跨零点标日期；刻度≥1天时全部标日期）
  const step = tickMs();
  ctx.strokeStyle = COLORS.scaleLine;
  ctx.fillStyle = COLORS.scaleLine;
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  for (let t = Math.ceil(firstMs / step) * step; t <= lastMs; t += step) {
    const x = Math.round(xFor(t)) + 0.5;
    const d = new Date(t);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    const text =
      midnight || step >= 86400000
        ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
        : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 20);
    ctx.stroke();
    // 文字钳制在画布内，边缘刻度的标注不裁切
    const tx = Math.min(Math.max(x - text.length * 3.5, 2), cssWidth - text.length * 7 - 2);
    ctx.fillText(text, tx, 34);
  }

  // 悬停指示线 + 指针处时间
  if (hoverX != null && hoverX >= 0 && hoverX <= cssWidth) {
    ctx.strokeStyle = COLORS.moveLine;
    ctx.beginPath();
    ctx.moveTo(hoverX, 0);
    ctx.lineTo(hoverX, 45);
    ctx.stroke();
    ctx.fillStyle = COLORS.moveDate;
    const hoverText = msToText(msAt(hoverX), false);
    ctx.fillText(hoverText, Math.min(hoverX + 4, cssWidth - hoverText.length * 6), 56);
  }

  // 当前选中时刻指示线：视图停在拖动位置时，指示线标注到选中时刻所在位置
  const curX = xFor(currentMs.value);
  if (curX >= PAD_X - 1 && curX <= cssWidth - PAD_X + 1) {
    ctx.strokeStyle = COLORS.meddleLine;
    ctx.beginPath();
    ctx.moveTo(curX, 0);
    ctx.lineTo(curX, 30);
    ctx.stroke();
    ctx.fillStyle = COLORS.meddleLine;
    const curText = msToText(currentMs.value, true);
    const tx = Math.min(Math.max(curX - curText.length * 3.5, 2), cssWidth - curText.length * 7 - 2);
    ctx.fillText(curText, tx, 44);
  }
}

/** 待执行的重绘帧回调 id（0 表示当前帧没有排队） */
let drawRaf = 0;

/**
 * 合并同一帧内的多次重绘请求。
 *
 * pointermove 在高刷新率设备上可达每秒上百次，而悬停线只需要每帧画一次。
 * 拖拽平移同理：指针事件远多于屏幕刷新率，逐事件重绘是纯浪费。
 */
function scheduleDraw(): void {
  if (drawRaf) return;
  drawRaf = requestAnimationFrame(() => {
    drawRaf = 0;
    draw();
  });
}

/** 尺寸变化时重设画布物理像素（dpr 适配高清屏）并重绘 */
function resize(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  cssWidth = canvas.clientWidth;
  if (cssWidth <= 0) return;
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(HEIGHT * dpr);
  ctx = canvas.getContext('2d');
  draw();
}

/* ─────────────── 交互 ─────────────── */
function onPointerDown(e: PointerEvent): void {
  if (!timesMs.length) return;
  dragging = true;
  dragMoved = false;
  downX = e.offsetX;
  downMs = viewMs ?? currentMs.value; // 锚定当前视图中心（可能与选中时刻不重合）
  canvasRef.value?.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  hoverX = e.offsetX;
  if (dragging && timesMs.length) {
    // 拖拽中仅自由平移视图（钳制在数据时间范围内），不选时、不触发取文件
    const raw = downMs + (downX - e.offsetX) * msPerPx();
    viewMs = Math.min(timesMs[timesMs.length - 1], Math.max(timesMs[0], raw));
    dragMoved = true;
  }
  // 指针事件频率高于屏幕刷新率，重绘交给 rAF 合并
  scheduleDraw();
}

function onPointerUp(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  const centerMsNow = viewMs ?? currentMs.value;
  // 拖动结束 → 吸附视图中心最近时次；未拖动 → 吸附点击位置最近时次。
  // emit 后视图保持不动（viewMs 不重置），指示线标注到选中时刻的位置。
  const target = dragMoved
    ? snapToTimes(centerMsNow)
    : snapToTimes(centerMsNow + (e.offsetX - cssWidth / 2) * msPerPx());
  if (target !== currentMs.value) {
    emitGuard = true;
    emit('change', msToISO(target, true));
    void nextTick(() => {
      emitGuard = false;
    });
  }
  draw();
}

function onPointerLeave(): void {
  hoverX = null;
  draw();
}

/** 滚轮缩放可见跨度：向上放大（跨度变小），步长 4h */
function onWheel(e: WheelEvent): void {
  e.preventDefault();
  spanHours = Math.min(maxSpanHours.value, Math.max(1, spanHours + (e.deltaY < 0 ? -4 : 4)));
  draw();
}

watch(
  () => [props.times, props.marks] as unknown,
  () => {
    // 二分吸附（snapToTimes）与标记裁剪（lowerBound）都要求升序。
    // store 侧虽已排序，这里再兜一次底，避免上游传入乱序数组导致吸附错位。
    timesMs = props.times.map(isoToMs).sort((a, b) => a - b);
    marksMs = (props.marks ?? []).map(isoToMs).sort((a, b) => a - b);
    if (spanHours > maxSpanHours.value) spanHours = maxSpanHours.value;
    viewMs = null; // 时间轴重建后视图重新居中
    draw();
  },
  { immediate: true }
);

watch(currentMs, () => {
  // 画布内部拖拽/点击选时：视图保持不动（停在拖动位置）
  // 外部跳转（下拉/步进/播放/锚点）：视图重新居中到当前时刻
  if (!emitGuard) viewMs = null;
  draw();
});

onMounted(() => {
  resizeObserver = new ResizeObserver(() => resize());
  if (canvasRef.value) resizeObserver.observe(canvasRef.value);
  resize();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  // 取消排队中的重绘：组件已卸载，回调再访问 canvas 没有意义
  if (drawRaf) {
    cancelAnimationFrame(drawRaf);
    drawRaf = 0;
  }
});
</script>

<template>
  <canvas
    ref="canvasRef"
    class="time-axis"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="onPointerLeave"
    @wheel="onWheel"
  ></canvas>
</template>
