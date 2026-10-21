<!--
  Legend.vue —— 色标浮层（每屏一个，可在地图内随意拖拽）

  功能：
    - props.productId 指定要展示的产品 → 多屏对比时各屏各自显示本屏产品色标；
    - props.screenId 指向所属屏，用于读写本屏的色标显示范围；
    - ★ 范围选择 ★：拖动双滑块选择数值区间，只有区间内的颜色会画到地图上，
      区间外格点渲染为透明；色标条上范围外的色块同步变暗；
    - 半透明深色背景压在底图之上；
    - ★ 可拖拽 ★：按住色标即可在所在屏的地图区域内自由移动，
      松开后停在该位置；拖出边界会被钳制回地图范围内。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { appState, getProductByIdSafe, setScreenRange } from '../store/appStore';
import {
  isValueInRange,
  rangeFromStopIndex,
  stopIndexFromRange
} from '../utils/range';

/** 要展示的产品代码 + 所属屏 id（范围选择是每屏独立状态） */
const props = defineProps<{ productId: string; screenId: number }>();

/**
 * 经纬度查询事件：把解析后的坐标交给所属屏去取值并弹窗。
 * 取值逻辑（产品、色标范围、阈值）属于 RadarScreen，图例只负责收集输入。
 */
const emit = defineEmits<{ query: [lat: number, lon: number] }>();

/** 该产品元信息 */
const product = computed(() => getProductByIdSafe(props.productId));

/** 有效色档（过滤透明兜底档，如 -100） */
const visibleStops = computed(() =>
  product.value.colorStops.filter((s) => s.stop[3] > 0)
);

/** 有效档位数值序列：滑块索引与色标色块一一对应 */
const stopValues = computed(() => visibleStops.value.map((s) => s.value));

/** rgba() 颜色字符串 */
const cssColor = (s: [number, number, number, number]) =>
  `rgba(${s[0]},${s[1]},${s[2]},${(s[3] / 255).toFixed(2)})`;

/* ─────────────── 色标数值范围 ─────────────── */

/** 本屏当前范围（null=全范围）；按 id 查找屏，不依赖数组下标 */
const screenRange = computed(
  () => appState.screens.find((s) => s.id === props.screenId)?.valueRange ?? null
);

/**
 * 滑块值（档位索引闭区间 [from, to]）。
 * 用索引而不是数值，是因为色标是离散分档的：
 * 拖动一格即“多显示/少显示一整档颜色”，不会出现半档状态。
 * 换算逻辑在 utils/range.ts，便于单测且渲染层复用同一口径。
 */
const rangeIndex = computed<[number, number]>(() =>
  stopIndexFromRange(stopValues.value, screenRange.value)
);

/* ─────────────── 手柄拖动（自绘，不依赖第三方组件内部布局） ─────────────── */

/**
 * 色标区容器：手柄定位与“拖动位置 → 档位”换算的基准。
 * 宽度等于色标条宽度，每个色块占 1/n。
 */
const rangeRef = ref<HTMLDivElement | null>(null);

/** 拖动中的临时档位区间（松手才写 store，避免拖动时反复重建数据源） */
const dragIndex = ref<[number, number] | null>(null);

/** 当前显示的档位区间：拖动中用临时值，否则跟随 store */
const displayIndex = computed<[number, number]>(
  () => dragIndex.value ?? rangeIndex.value
);

/** 正在拖动的手柄：start=下限 / end=上限 */
let dragSide: 'start' | 'end' | null = null;

/**
 * 手柄的水平位置：与色块中心对齐。
 * 第 i 档色块占据 [i/n, (i+1)/n)，中心在 (i+0.5)/n。
 */
function handleLeft(index: number): string {
  const n = stopValues.value.length;
  if (n <= 1) return '50%';
  return `${((index + 0.5) / n) * 100}%`;
}

/** 按下手柄：开始拖动并捕获指针（capture 后 move/up 都发给该手柄） */
function onHandleDown(e: PointerEvent, side: 'start' | 'end'): void {
  dragSide = side;
  dragIndex.value = [...rangeIndex.value] as [number, number];
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
  e.stopPropagation(); // 不触发图例浮层整体拖拽
}

/** 拖动中：横向位置 → 档位索引，并钳制在另一手柄内侧 */
function onHandleMove(e: PointerEvent): void {
  if (!dragSide || !rangeRef.value) return;
  const n = stopValues.value.length;
  if (n < 2) return;

  const rect = rangeRef.value.getBoundingClientRect();
  const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  // ratio*n 落在第几档色块内，向下取整即该档索引
  const idx = Math.min(Math.floor(ratio * n), n - 1);

  const cur = dragIndex.value ?? ([...rangeIndex.value] as [number, number]);
  if (dragSide === 'start') cur[0] = Math.min(idx, cur[1]);
  else cur[1] = Math.max(idx, cur[0]);
  dragIndex.value = [cur[0], cur[1]];
}

/** 松手：把最终区间写回 store（此时才触发图层重建与地图重绘） */
function onHandleUp(): void {
  if (!dragSide) return;
  const idx = dragIndex.value;
  dragSide = null;
  dragIndex.value = null;
  if (idx) applyRangeIndex(idx[0], idx[1]);
}

/** 当前范围的可读文本，如 “20 ~ 55 dBZ” */
const rangeText = computed(() => {
  const r = screenRange.value;
  if (!r) return '全范围';
  const unit = product.value.unit ? ' ' + product.value.unit : '';
  const maxText = Number.isFinite(r.max) ? String(r.max) : '最大';
  return `${r.min} ~ ${maxText}${unit}`;
});

/** 色块是否落在显示范围外（范围外色块变暗，提示“这段颜色不会画到图上”） */
function isMuted(value: number): boolean {
  return !isValueInRange(value, screenRange.value);
}

/**
 * 档位索引 → 数值范围写回 store。
 * 换算（含“结束档取下一档值”的左闭右开语义）在 utils/range.ts。
 */
function applyRangeIndex(from: number, to: number): void {
  setScreenRange(
    props.screenId,
    rangeFromStopIndex(stopValues.value, from, to)
  );
}

/** 恢复全范围色标 */
function resetRange(): void {
  setScreenRange(props.screenId, null);
}

/* ─────────────── 经纬度查询 ─────────────── */

/** 经度输入框内容 */
const lonInput = ref('');

/** 纬度输入框内容 */
const latInput = ref('');

/** 校验错误提示（空串表示无错误） */
const coordError = ref('');

/**
 * 解析输入并提交查询（经度、纬度分开填写）。
 *
 * 容错：如果把「118.9269,33.6378」整串粘进经度框、纬度框为空，
 * 会按逗号/空格拆成两个值，省去手动分开。
 *
 * 校验只拦截明显非法输入，范围与地图点击取值无关。
 */
function onQuery(): void {
  let lonText = lonInput.value.trim();
  let latText = latInput.value.trim();

  // 整串坐标粘到单框时的自动拆分
  if (!latText && /[,，\s]/.test(lonText)) {
    const parts = lonText.split(/[,，\s]+/).filter(Boolean);
    if (parts.length >= 2) {
      lonText = parts[0];
      latText = parts[1];
      lonInput.value = lonText;
      latInput.value = latText;
    }
  }

  if (!lonText || !latText) {
    coordError.value = '请填写经度和纬度';
    return;
  }

  const lon = Number(lonText);
  const lat = Number(latText);
  if (!Number.isFinite(lon)) {
    coordError.value = '经度必须是数字';
    return;
  }
  if (!Number.isFinite(lat)) {
    coordError.value = '纬度必须是数字';
    return;
  }
  if (lon < -180 || lon > 180) {
    coordError.value = '经度范围 -180 ~ 180';
    return;
  }
  if (lat < -90 || lat > 90) {
    coordError.value = '纬度范围 -90 ~ 90';
    return;
  }

  coordError.value = '';
  emit('query', lat, lon);
}

/* ─────────────── 拖拽逻辑 ─────────────── */

const rootRef = ref<HTMLDivElement | null>(null);

/**
 * 浮层位置（相对父容器 .map-area 的左上角，px）。
 * 为 null 时表示“未拖过”，走 CSS 默认的右下角锚定（right/bottom）；
 * 一旦开始拖拽就切换为 left/top 绝对定位。
 */
const pos = ref<{ left: number; top: number } | null>(null);

let dragging = false;
let startX = 0;
let startY = 0;
let startLeft = 0;
let startTop = 0;

/** 按下：记录起点，把当前位置换算为 left/top 并开始捕获指针 */
function onPointerDown(e: PointerEvent): void {
  const el = rootRef.value;
  if (!el || !el.parentElement) return;
  const rect = el.getBoundingClientRect();
  const prect = el.parentElement.getBoundingClientRect();

  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  startLeft = rect.left - prect.left;
  startTop = rect.top - prect.top;
  pos.value = { left: startLeft, top: startTop };

  // 捕获指针：即使鼠标移出浮层也能持续接收 move 事件
  el.setPointerCapture(e.pointerId);
  e.preventDefault(); // 防止选中文字/触发地图拖拽
}

/** 移动：按偏移量更新位置，并钳制在父容器（地图区域）内 */
function onPointerMove(e: PointerEvent): void {
  if (!dragging || !rootRef.value || !rootRef.value.parentElement) return;
  const parent = rootRef.value.parentElement;
  const maxX = parent.clientWidth - rootRef.value.offsetWidth;
  const maxY = parent.clientHeight - rootRef.value.offsetHeight;

  const x = Math.min(Math.max(startLeft + (e.clientX - startX), 0), Math.max(maxX, 0));
  const y = Math.min(Math.max(startTop + (e.clientY - startY), 0), Math.max(maxY, 0));
  pos.value = { left: x, top: y };
}

/** 抬起：结束拖拽 */
function onPointerUp(): void {
  dragging = false;
}

/**
 * 父容器尺寸变化后，把已拖动的图例钳制回可见范围。
 *
 * ★ 为什么需要 ★
 *   图例位置（pos）是组件内部状态，布局从 1 屏切到 4 屏时第 1 屏组件被复用，
 *   旧位置可能超出变矮后的地图区域，被 `.radar-screen` 的 overflow:hidden 裁掉
 *   —— 表现为“第一屏色标消失，只在底边露出一条背景”。
 *   新增屏是新组件（pos=null），所以只有被复用的屏受影响。
 */
function clampPosToParent(): void {
  const el = rootRef.value;
  const parent = el?.parentElement;
  if (!pos.value || !el || !parent) return;

  const maxX = Math.max(parent.clientWidth - el.offsetWidth, 0);
  const maxY = Math.max(parent.clientHeight - el.offsetHeight, 0);
  pos.value = {
    left: Math.min(Math.max(pos.value.left, 0), maxX),
    top: Math.min(Math.max(pos.value.top, 0), maxY)
  };
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const parent = rootRef.value?.parentElement;
  if (!parent) return;
  // 观察地图容器：布局切换、窗口缩放都会触发，保证图例始终在可见区域内
  resizeObserver = new ResizeObserver(clampPosToParent);
  resizeObserver.observe(parent);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <div
    ref="rootRef"
    class="legend-float"
    title="按住可拖动"
    v-if="visibleStops.length"
    :style="pos ? { left: pos.left + 'px', top: pos.top + 'px', right: 'auto', bottom: 'auto' } : undefined"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div class="legend-unit">{{ product.name }}（{{ product.unit || '-' }}）</div>

    <!-- 色标条 + 叠加的范围滑块：滑块轨道横穿色标条，手柄压在上层 -->
    <div class="legend-bar-wrap">
      <div class="legend-bar">
        <div
          v-for="(s, i) in visibleStops"
          :key="i"
          class="legend-cell"
          :class="{ 'legend-cell--muted': isMuted(s.value) }"
          :style="{ background: cssColor(s.stop) }"
        ></div>
      </div>

      <!--
        范围选择：只把选中区间的颜色画到地图上。
        手柄在 pointerdown 中自行 stopPropagation，避免拖动时带动整个图例浮层；
        未盖住手柄的空白区域保持 pointer-events:none，仍可拖动图例。
      -->
      <div ref="rangeRef" class="legend-range">
        <div
          class="legend-handle"
          :style="{ left: handleLeft(displayIndex[0]) }"
          title="下限"
          @pointerdown="onHandleDown($event, 'start')"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
        ></div>
        <div
          class="legend-handle"
          :style="{ left: handleLeft(displayIndex[1]) }"
          title="上限"
          @pointerdown="onHandleDown($event, 'end')"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
        ></div>
      </div>
    </div>

    <div class="legend-ticks">
      <span v-for="s in visibleStops" :key="'t' + s.value">{{ s.value }}</span>
    </div>

    <!--
      范围文本与重置：放在色标下方，不占用色标条区域。
      ★ 重置按钮必须 @pointerdown.stop ★
        否则 pointerdown 冒泡到图例根元素 → 触发浮层拖拽并 setPointerCapture，
        指针被根元素捕获后按钮收不到 click，表现为“点重置没反应”。
    -->
    <div class="legend-range-info">
      <span class="legend-range-text">{{ rangeText }}</span>
      <button
        v-if="screenRange"
        class="legend-reset"
        @pointerdown.stop
        @click.stop="resetRange"
      >
        重置
      </button>
    </div>

    <!--
      经纬度查询：经度、纬度分开填 → 在该位置弹窗显示本屏数值。
      ★ 容器必须 @pointerdown.stop ★ 否则按下输入框会触发浮层拖拽
        并 setPointerCapture，输入框拿不到焦点（与重置按钮同一坑）。
    -->
    <div class="legend-query" @pointerdown.stop>
      <input
        v-model="lonInput"
        class="legend-query-input"
        type="text"
        inputmode="decimal"
        placeholder="经度"
        title="经度（-180 ~ 180），如 118.9269"
        @keydown.enter="onQuery"
      />
      <input
        v-model="latInput"
        class="legend-query-input"
        type="text"
        inputmode="decimal"
        placeholder="纬度"
        title="纬度（-90 ~ 90），如 33.6378"
        @keydown.enter="onQuery"
      />
      <button class="legend-query-btn" @click.stop="onQuery">查询</button>
    </div>
    <div v-if="coordError" class="legend-query-error">{{ coordError }}</div>
  </div>
</template>
