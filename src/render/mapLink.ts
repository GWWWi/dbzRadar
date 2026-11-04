/**
 * render/mapLink.ts —— 多屏地图联动（缩放/平移同步）
 *
 * 联动开关与登记表都在本文件；底图资源清理不在这里（见 mapManager 门面），
 * 避免 mapLink ↔ baseMap 循环依赖。
 */
import type { LMap } from '@quickearth/leaflet';

/** 联动开关（模块级，跨屏共享）；Toolbar 通过 setMapLink 切换 */
let mapLinkEnabled = true;

/**
 * 程序化同步视野的抑制标记：
 * setView 会触发其他地图的 move 事件，不加标记会互相触发形成死循环。
 */
let syncing = false;

/** 已登记的地图、move 处理器与待执行帧回调的取消函数（组件卸载时按 map 解除） */
const linkedMaps: { map: LMap; onMove: () => void; cancel: () => void }[] = [];

/**
 * 设置地图联动开关（Toolbar 调用，与 appState.syncMap 保持一致）。
 * true：任一屏缩放/移动地图时，其余屏同步相同视野；false：各屏独立操作。
 */
export function setMapLink(enabled: boolean): void {
  mapLinkEnabled = enabled;
}

/**
 * 把地图纳入联动管理（RadarScreen onMounted 时调用）。
 * 若已有其他屏地图且联动开启，新地图立即对齐到当前联动视野
 * （多屏切换布局时保持各屏视野一致）。
 */
export function registerMapLink(map: LMap): void {
  /** 本图待执行的帧回调 id（0 表示当前帧没有待执行任务） */
  let rafId = 0;

  /** 真正的一次联动同步：只在帧回调里执行，保证每帧最多一次 setView */
  const syncNow = (): void => {
    rafId = 0;
    if (!mapLinkEnabled || syncing) return;
    syncing = true;
    try {
      const center = map.getCenter();
      const zoom = map.getZoom();
      for (const item of linkedMaps) {
        if (item.map === map) continue;
        item.map.setView(center, zoom, { animate: false });
      }
    } finally {
      syncing = false;
    }
  };

  /**
   * 拖拽 / 滚轮缩放会连续触发 move 事件（每帧可能多次）。
   * 用 requestAnimationFrame 合并为“每帧最多同步一次”，
   * 避免 4~6 屏各自 setView 造成的布局抖动与主线程开销。
   *
   * ★ syncing 判断必须放在这里 ★
   *   syncNow 里对其他地图 setView 会同步触发它们的 move。
   *   若不加此判断，这些“程序化移动”会各自排一个帧回调，
   *   下一帧又反向 setView 回来，形成永不停止的帧循环。
   */
  const onMove = (): void => {
    if (syncing) return;
    if (rafId) return;
    rafId = requestAnimationFrame(syncNow);
  };

  map.on('move', onMove);
  linkedMaps.push({
    map,
    onMove,
    // 卸载时取消尚未执行的帧回调，防止地图销毁后仍被操作
    cancel: () => {
      if (!rafId) return;
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  });

  const first = linkedMaps[0];
  if (mapLinkEnabled && first && first.map !== map) {
    syncing = true;
    map.setView(first.map.getCenter(), first.map.getZoom(), { animate: false });
    syncing = false;
  }
}

/**
 * 解除地图联动登记（mapManager.unregisterMapLink 调用）。
 * 只处理联动本身；底图资源由 mapManager 门面统一清理。
 */
export function unregisterMapLink(map: LMap): void {
  const idx = linkedMaps.findIndex((it) => it.map === map);
  if (idx < 0) return;
  const [item] = linkedMaps.splice(idx, 1);
  // 先解绑事件，再取消待执行的帧回调：两者都做才是完整清理
  item.map.off('move', item.onMove);
  item.cancel();
}

/** 遍历当前已登记的地图（底图批量切换用） */
export function forEachLinkedMap(cb: (map: LMap) => void): void {
  for (const item of linkedMaps) cb(item.map);
}
