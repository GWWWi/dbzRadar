<!--
  ScreenHeader.vue —— 单屏屏头

  职责：
    - 显示屏序号 / 产品 / 时间 / 状态；
    - 仰角层选择（仅 RSTM 基数据体显示）；
    - 每屏独立的平滑开关；
    - 每屏独立的上传入口（文件选择后 emit('upload', file)，解析与渲染由父组件负责）。
-->
<script setup lang="ts">
import { computed } from 'vue';
import {
  appState,
  getProductByIdSafe,
  setScreenElevation,
  setScreenSmooth
} from '../store/appStore';
import { formatShortTime } from '../utils/datetime';

const props = defineProps<{ screenId: number }>();
const emit = defineEmits<{ (e: 'upload', file: File): void }>();

/** 本屏状态：按 id 查找，不依赖数组下标 */
const screen = computed(() => appState.screens.find((s) => s.id === props.screenId));

/** 展示序号 = 数组位置 + 1（id 是稳定标识，显示序号与 id 解耦） */
const screenIndex = computed(() => {
  const i = appState.screens.findIndex((s) => s.id === props.screenId);
  return i >= 0 ? i + 1 : props.screenId + 1;
});

const isActive = computed(() => appState.activeScreenId === props.screenId);
const status = computed(() => screen.value?.status ?? '');

/** 产品名用 safe 查找：产品目录尚未落库时也能回退静态目录 */
const productName = computed(() => getProductByIdSafe(screen.value?.productId ?? 'dBZ').name);
const timeText = computed(() => formatShortTime(screen.value?.time ?? ''));

/**
 * 「示意数据」悬停说明：屏头空间只够挂一个标记，
 * 但必须让值班人员看清“这不是实际天气”，不能只留三个字。
 */
const SYNTH_TIP = '该文件未能真实解码，画面是程序生成的演示团块，禁止用于任何业务判断';

function onSmoothChange(e: Event): void {
  setScreenSmooth(props.screenId, (e.target as HTMLInputElement).checked);
}

function onElevationChange(e: Event): void {
  setScreenElevation(props.screenId, Number((e.target as HTMLSelectElement).value));
}

/** 选择文件后立即清空 input，允许重复选择同一文件 */
function onUploadChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) emit('upload', file);
}
</script>

<template>
  <div class="screen-header">
    <span>第 {{ screenIndex }} 屏</span>
    <span class="screen-info">{{ productName }} · {{ timeText }}</span>
    <!-- title：上传文件名过长被省略时，悬停可查看完整内容 -->
    <span v-if="status" class="screen-status" :title="status">{{ status }}</span>
    <!--
      示意数据警示：独立于状态文本。
      上传的合成/旧格式文件同样需要这条警示，与「上传数据 · 文件名」并存。
    -->
    <span v-if="screen?.synthetic" class="screen-synth" :title="SYNTH_TIP">⚠ 示意数据</span>
    <span v-if="isActive" class="active-dot">●</span>

    <!--
      仰角层选择（仅 RSTM 基数据体显示）：该格式一个文件含 9 个仰角层
      （0.5° ~ 19.5°），每层是独立的一次扫描，可按需切换查看。
    -->
    <select
      v-if="screen?.elevations.length"
      class="screen-elev"
      :value="screen?.elevationIndex ?? 0"
      title="选择仰角层（RSTM 基数据 9 层）"
      @change="onElevationChange"
    >
      <option v-for="(e, i) in screen?.elevations ?? []" :key="i" :value="i">
        {{ e.toFixed(1) }}°
      </option>
    </select>

    <!-- 本屏平滑开关（每屏独立，便于多屏对比平滑效果） -->
    <label class="screen-smooth" title="平滑=双线性插值渲染；不平滑=格点填色（原始色块）">
      <input
        type="checkbox"
        :checked="screen?.smooth ?? false"
        @change="onSmoothChange"
      />
      平滑
    </label>

    <!-- 本屏数据上传（每屏独立）：格式识别与渲染由 RadarScreen 处理 -->
    <label
      class="btn screen-upload"
      title="上传雷达数据文件（支持 SWAN 拼图 / CINRAD RSTM / MICAPS m4）"
    >
      上传
      <input type="file" accept=".bin,.m4,.bz2" hidden @change="onUploadChange" />
    </label>
  </div>
</template>
