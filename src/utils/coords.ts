/**
 * utils/coords.ts —— 经纬度展示格式化
 *
 * 为什么需要：
 *   弹窗与查询面板原先各自拼 `${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E`，
 *   负值（南纬 / 西经）会显示成 “-100.000°E” 这种方向自相矛盾的文本。
 *   小数值不是问题，方向标错了会被当成“东经 100 度”。
 */

/** 保留小数位（默认 3 位：约 100m，与格距同量级） */
const DEFAULT_DIGITS = 3;

/** 纬度：正值 N、负值 S（绝对值 + 半球，不出现 “-33°N”） */
export function formatLat(lat: number, digits: number = DEFAULT_DIGITS): string {
  if (!Number.isFinite(lat)) return '--';
  return `${Math.abs(lat).toFixed(digits)}°${lat < 0 ? 'S' : 'N'}`;
}

/** 经度：正值 E、负值 W */
export function formatLon(lon: number, digits: number = DEFAULT_DIGITS): string {
  if (!Number.isFinite(lon)) return '--';
  return `${Math.abs(lon).toFixed(digits)}°${lon < 0 ? 'W' : 'E'}`;
}

/**
 * 经纬度对 → '33.638°N, 118.927°E'。
 * 弹窗用 3 位、查询面板用 4 位，位数由调用方指定但方向规则只有这一份。
 */
export function formatLatLon(
  lat: number,
  lon: number,
  digits: number = DEFAULT_DIGITS
): string {
  return `${formatLat(lat, digits)}, ${formatLon(lon, digits)}`;
}
