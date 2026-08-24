<!--
  TimeAxis.vue —— Canvas 绘制的时间轴（视觉与交互参考 timeline-canvas 项目）

  视觉：
    - 深色背景 + 顶部刻度条（scaleBar）；
    - 刻度线（间隔随可见跨度自适应，跨零点标注日期）；
    - 中央绿色指示线 + 当前时间；悬停灰色线 + 指针处时间；
    - 顶条上以绿色小刻度标记“有文件”的时次（marks）。
  交互：
    - 拖拽左右平移时间（吸附到最近的可用时次）；
    - 点击任意位置 → 跳转到该处最近时次；
    - 滚轮缩放可见时间跨度（1h ~ 时间轴总跨度）。

  受控组件：自身不保存当前时间，拖拽/点击吸附后 emit('change')，
  由父组件写回 store 再经 props 更新，保证单一数据源。
-->
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue';

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
/** 拖拽状态：按下位置/按下时中心时刻/是否发生过移动 */
let dragging = false;
let dragMoved = false;
let downX = 0;
let downMs = 0;

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
function msPerPx(): number {
  return (spanHours * 3600000) / Math.max(1, cssWidth);
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
  const center = currentMs.value;
  const firstMs = center - (spanHours * 3600000) / 2;
  const lastMs = center + (spanHours * 3600000) / 2;

  // 有文件的时次标记（顶条绿色小刻度）
  ctx.fillStyle = COLORS.meddleLine;
  for (const ms of marksMs) {
    if (ms < firstMs || ms > lastMs) continue;
    ctx.fillRect((ms - firstMs) / mpp - 1, 0, 2, 20);
  }

  // 刻度线与标注（跨零点标日期；刻度≥1天时全部标日期）
  const step = tickMs();
  ctx.strokeStyle = COLORS.scaleLine;
  ctx.fillStyle = COLORS.scaleLine;
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  for (let t = Math.ceil(firstMs / step) * step; t <= lastMs; t += step) {
    const x = Math.round((t - firstMs) / mpp) + 0.5;
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
    ctx.fillText(text, x - text.length * 3.5, 34);
  }

  // 悬停指示线 + 指针处时间
  if (hoverX != null && hoverX >= 0 && hoverX <= cssWidth) {
    ctx.strokeStyle = COLORS.moveLine;
    ctx.beginPath();
    ctx.moveTo(hoverX, 0);
    ctx.lineTo(hoverX, 45);
    ctx.stroke();
    ctx.fillStyle = COLORS.moveDate;
    const hoverText = fmtFull(firstMs + hoverX * mpp);
    ctx.fillText(hoverText, Math.min(hoverX + 4, cssWidth - hoverText.length * 6), 56);
  }

  // 中央指示线 + 当前时间
  const cx = cssWidth / 2;
  ctx.strokeStyle = COLORS.meddleLine;
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, 30);
  ctx.stroke();
  ctx.fillStyle = COLORS.meddleLine;
  const curText = fmtFull(center);
  ctx.fillText(curText, cx - curText.length * 3.5, 44);
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
  downMs = currentMs.value;
  canvasRef.value?.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  hoverX = e.offsetX;
  if (dragging && timesMs.length) {
    // 按下时的中心时刻 + 位移换算 → 吸附最近时次
    const target = snapToTimes(downMs + (downX - e.offsetX) * msPerPx());
    if (target !== currentMs.value) {
      dragMoved = true;
      emit('change', fmtISO(target));
    }
  }
  draw();
}

function onPointerUp(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  // 未拖动视为点击：把点击位置的时间（吸附后）设为当前
  if (!dragMoved && timesMs.length) {
    const target = snapToTimes(currentMs.value + (e.offsetX - cssWidth / 2) * msPerPx());
    if (target !== currentMs.value) emit('change', fmtISO(target));
  }
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
    draw();
  },
  { immediate: true }
);

watch(currentMs, () => draw());

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
