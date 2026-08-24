<!--
  Toolbar.vue —— 顶部工具栏

  功能：
    - 多屏布局切换（1 / 2 / 4 / 6 屏），用于多屏对比；
    - “多屏同步”开关：开启后时间轴控制所有屏（同一时刻对比不同产品），
      关闭则各屏时间独立（同一产品对比不同时刻）；
    - “地图联动”开关：开启后任一屏缩放/移动地图，其余屏同步相同视野
      （缩放+平移），关闭则各屏地图独立操作；
    - 播放 / 暂停动画按钮。
-->
<script setup lang="ts">
import { appState, setLayout, setPlaying, setSyncPlay, setSyncMap } from '../store/appStore';
import { setMapLink } from '../render/mapManager';
import type { LayoutType } from '../store/appStore';

/** 可选布局 */
const layouts: LayoutType[] = [1, 2, 4, 6];

/** 地图联动开关：状态进 store（UI 响应式），行为由 mapManager 生效 */
function onToggleMapLink(v: boolean): void {
  setSyncMap(v);
  setMapLink(v);
}
</script>

<template>
  <header class="toolbar">
    <div class="toolbar-title">二维雷达显示平台 · 反射率</div>

    <!-- 布局切换：1/2/4/6 屏 -->
    <div class="toolbar-group">
      <span class="toolbar-label">多屏对比</span>
      <button
        v-for="n in layouts"
        :key="n"
        class="btn"
        :class="{ 'btn-active': appState.layout === n }"
        :title="`${n} 屏对比`"
        @click="setLayout(n)"
      >
        {{ n }}屏
      </button>
    </div>

    <!-- 同步开关 + 地图联动 + 播放 -->
    <div class="toolbar-group">
      <label class="chk">
        <input
          type="checkbox"
          :checked="appState.syncPlay"
          @change="setSyncPlay(($event.target as HTMLInputElement).checked)"
        />
        多屏同步
      </label>
      <label class="chk" title="开启后任一屏缩放/移动地图，其余屏同步相同视野">
        <input
          type="checkbox"
          :checked="appState.syncMap"
          @change="onToggleMapLink(($event.target as HTMLInputElement).checked)"
        />
        地图联动
      </label>
      <button class="btn" @click="setPlaying(!appState.playing)">
        {{ appState.playing ? '⏸ 暂停' : '▶ 播放' }}
      </button>
    </div>
  </header>
</template>
