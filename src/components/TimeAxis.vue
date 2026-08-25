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
const p2 = (n: number): string => String(n).padStart(2, '0');
const toMs = (iso: string): number => new Date(iso).getTime();

/** ms → 本地 ISO 串 'YYYY-MM-DDTHH:mm:ss'（与平台时刻格式一致） */
function fmtISO(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** ms → 'YYYY-MM-DD HH:mm:ss'（画布文字） */
function fmtFull(ms: number): string {
  return fmtISO(ms).replace('T', ' ');
}

/** ms → 'YYYY-MM-DD HH:mm'（悬停提示文字，到分钟） */
function fmtMin(ms: number): string {
  return fmtISO(ms).replace('T', ' ').slice(0, 16);
}

/** 当前中心时刻（ms） */
const currentMs = computed(() =>
  props.current ? toMs(props.current) : Math.floor(Date.now() / 60000) * 60000
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
  ctx.fillStyle = COLORS.meddleLine;
  for (const ms of marksMs) {
    if (ms < firstMs || ms > lastMs) continue;
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
        ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
        : `${p2(d.getHours())}:${p2(d.getMinutes())}`;
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
    const hoverText = fmtMin(msAt(hoverX));
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
    const curText = fmtFull(currentMs.value);
    const tx = Math.min(Math.max(curX - curText.length * 3.5, 2), cssWidth - curText.length * 7 - 2);
    ctx.fillText(curText, tx, 44);
  }
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
  draw();
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
    emit('change', fmtISO(target));
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
    timesMs = props.times.map(toMs);
    marksMs = (props.marks ?? []).map(toMs);
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
