<!--
  Legend.vue —— 色标浮层（每屏一个，可在地图内随意拖拽）

  功能：
    - props.productId 指定要展示的产品 → 多屏对比时各屏各自显示本屏产品色标；
    - 半透明深色背景压在底图之上；
    - ★ 可拖拽 ★：按住色标即可在所在屏的地图区域内自由移动，
      松开后停在该位置；拖出边界会被钳制回地图范围内。
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { getProductByIdSafe } from '../store/appStore';

/** 要展示的产品代码（来自所属屏的当前产品） */
const props = defineProps<{ productId: string }>();

/** 该产品元信息 */
const product = computed(() => getProductByIdSafe(props.productId));

/** 有效色档（过滤透明兜底档，如 -100） */
const visibleStops = computed(() =>
  product.value.colorStops.filter((s) => s.stop[3] > 0)
);

/** rgba() 颜色字符串 */
const cssColor = (s: [number, number, number, number]) =>
  `rgba(${s[0]},${s[1]},${s[2]},${(s[3] / 255).toFixed(2)})`;

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
    <div class="legend-bar">
      <div
        v-for="(s, i) in visibleStops"
        :key="i"
        class="legend-cell"
        :style="{ background: cssColor(s.stop) }"
      ></div>
    </div>
    <div class="legend-ticks">
      <span v-for="s in visibleStops" :key="'t' + s.value">{{ s.value }}</span>
    </div>
  </div>
</template>
