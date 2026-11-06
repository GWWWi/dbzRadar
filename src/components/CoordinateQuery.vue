<!--
  CoordinateQuery.vue —— 坐标查询面板（地图左下角）

  职责：
    - 经纬度输入、格式容错与范围校验；
    - 调用父组件传入的 sample(lat, lon) 取样；
    - 展示原始值 / 9 点均值 / 不可见原因。

  ★ 取样与地图弹窗由父组件负责 ★
    面板只拿结果，不直接持有地图/图层对象，避免 UI 组件依赖渲染细节。
-->
<script setup lang="ts">
import { ref } from 'vue';
import type { RadarQueryResult } from '../types';
import { QUERY_DIFF_TIP, QUERY_LABEL } from '../constants/messages';
import { formatLatLon } from '../utils/coords';

const props = defineProps<{
  /**
   * 父组件取样入口：返回面板结果；地图弹窗也由该函数内部完成。
   * ★ 不再传 notify 开关 ★ 面板本身就展示全部结果，父组件无需再额外弹提示。
   */
  sample: (lat: number, lon: number) => RadarQueryResult | null;
}>();

/** 经度输入 */
const lonInput = ref('');
/** 纬度输入 */
const latInput = ref('');
/** 输入校验错误 */
const queryError = ref('');
/** 最近一次查询结果 */
const queryResult = ref<RadarQueryResult | null>(null);

/**
 * 坐标查询：校验输入 → 取样。
 *
 * 容错：把「118.9269,33.6378」整串粘进经度框、纬度框为空时自动拆分。
 */
function onQueryClick(): void {
  let lonText = lonInput.value.trim();
  let latText = latInput.value.trim();

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
    queryError.value = '请填写经度和纬度';
    return;
  }

  const lon = Number(lonText);
  const lat = Number(latText);
  if (!Number.isFinite(lon)) {
    queryError.value = '经度必须是数字';
    return;
  }
  if (!Number.isFinite(lat)) {
    queryError.value = '纬度必须是数字';
    return;
  }
  if (lon < -180 || lon > 180) {
    queryError.value = '经度范围 -180 ~ 180';
    return;
  }
  if (lat < -90 || lat > 90) {
    queryError.value = '纬度范围 -90 ~ 90';
    return;
  }

  queryError.value = '';
  queryResult.value = props.sample(lat, lon);
}
</script>

<template>
  <div class="coord-query" @pointerdown.stop @wheel.stop>
    <div class="coord-query-title">坐标查询</div>
    <div class="coord-query-row">
      <input
        v-model="lonInput"
        class="coord-query-input"
        type="text"
        inputmode="decimal"
        placeholder="经度"
        title="经度（-180 ~ 180），如 118.9269"
        @keydown.enter="onQueryClick"
      />
      <input
        v-model="latInput"
        class="coord-query-input"
        type="text"
        inputmode="decimal"
        placeholder="纬度"
        title="纬度（-90 ~ 90），如 33.6378"
        @keydown.enter="onQueryClick"
      />
      <button class="coord-query-btn" @click="onQueryClick">查询</button>
    </div>

    <div v-if="queryError" class="coord-query-err">{{ queryError }}</div>

    <div v-if="queryResult" class="coord-query-result">
      <div>
        {{ QUERY_LABEL.raw }}：
        <b>{{ queryResult.center === null ? '无数据' : queryResult.center.toFixed(1) }}</b>
        {{ queryResult.unit }}
      </div>
      <div>
        {{ QUERY_LABEL.mean9 }}：
        <b>{{ queryResult.mean === null ? '—' : queryResult.mean.toFixed(1) }}</b>
        {{ queryResult.mean === null ? '' : queryResult.unit }}
        <span class="coord-query-count" v-if="queryResult.totalCount">
          （{{ queryResult.validCount }}/{{ queryResult.totalCount }} 有效）
        </span>
      </div>
      <div v-if="queryResult.note" class="coord-query-note">{{ queryResult.note }}</div>
      <!--
        数据来源 / 取值口径：不同格式（m4 / 拼图 / RSTM 基数据）同点数值本就不同，
        不标明会被当成取值 bug。悬停看完整解释。
      -->
      <div
        v-if="queryResult.source"
        class="coord-query-source"
        :title="queryResult.source.tip"
      >
        {{ QUERY_LABEL.source }}：{{ queryResult.source.label }}
      </div>
      <!-- 经纬度统一走 utils/coords：负值显示为 S / W -->
      <div class="coord-query-coord">
        {{ formatLatLon(queryResult.lat, queryResult.lon, 4) }}
      </div>
    </div>

    <!-- 常驻说明（默认折叠，不占地方）：解释“换个文件数值为什么不一样” -->
    <details class="coord-query-help">
      <summary>不同文件结果为何不同？</summary>
      <p>{{ QUERY_DIFF_TIP }}</p>
    </details>
  </div>
</template>
