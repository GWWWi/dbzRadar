/**
 * utils/datetime.ts —— 时间格式转换的唯一实现
 *
 * 平台内部统一用「不带时区标记的 ISO 串」表示时刻：
 *   'yyyy-MM-ddTHH:mm:ss'（如 '2024-06-21T14:00:00'）
 * 语义上按本地时区（部署环境为北京时间）解释，不做 UTC 换算 ——
 * 与数据文件“北京时间直存”的约定保持一致。
 *
 * 为什么集中在这里：
 *   原先 configApi / radarApi / TimeAxis / Timeline 各写了一份 ISO 生成与
 *   紧凑串换算。时间轴生成的时刻串必须与文件地址模板、控件 value 完全同源，
 *   任何一处格式漂移都会导致“时间轴有时次、却查不到文件”。
 *   ★ 新增时间格式需求请在本文件扩展，禁止在业务文件里再写一份。★
 */

/** 两位补零（00~99） */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 毫秒时间戳 → ISO 串（本地时区）。
 *
 * @param ms          时间戳
 * @param withSeconds 是否输出秒位。false 时秒固定为 00
 *                    （时间轴/配置时刻均为整分钟语义，避免秒位造成查不到文件）
 */
export function msToISO(ms: number, withSeconds = false): string {
  const d = new Date(ms);
  const head =
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withSeconds ? `${head}:${pad2(d.getSeconds())}` : `${head}:00`;
}

/**
 * 毫秒时间戳 → 显示文本 'YYYY-MM-DD HH:mm[:ss]'（画布/提示文字用）。
 */
export function msToText(ms: number, withSeconds = false): string {
  return msToISO(ms, withSeconds).replace('T', ' ');
}

/** ISO 串 → 毫秒；非法串返回 NaN（与 new Date().getTime() 行为一致） */
export function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * ISO 串 → 紧凑串（去掉分隔符），用于 Element Plus 控件的 value-format。
 *
 * @param iso '2024-06-21T14:00:00'
 * @param len 12 → 'YYYYMMDDHHmm'（分钟精度，控件用）；
 *            14 → 'YYYYMMDDHHmmss'（文件地址模板 {time} 用）
 */
export function isoToCompact(iso: string, len: 12 | 14 = 14): string {
  return iso.replace(/[-:T]/g, '').slice(0, len);
}

/**
 * 12 位紧凑串 'YYYYMMDDHHmm' → ISO 串（秒固定 00）。
 * 长度不符返回空串，调用方据此跳过无效输入（不抛错，符合控件容错场景）。
 */
export function compact12ToISO(v: string): string {
  if (v.length !== 12) return '';
  return (
    v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8) +
    'T' + v.slice(8, 10) + ':' + v.slice(10, 12) + ':00'
  );
}

/**
 * 14 位紧凑串 'YYYYMMDDHHmmss' → ISO 串。
 * 用于文件名/manifest 中的时间戳；长度不符返回空串。
 */
export function digits14ToISO(d: string): string {
  if (d.length !== 14) return '';
  return (
    d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) +
    'T' + d.slice(8, 10) + ':' + d.slice(10, 12) + ':' + d.slice(12, 14)
  );
}
