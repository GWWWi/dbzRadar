/**
 * utils/datetime.ts —— 时间格式转换的唯一实现
 *
 * 平台内部统一用「不带时区标记的 ISO 串」表示时刻：
 *   'yyyy-MM-ddTHH:mm:ss'（如 '2024-06-21T14:00:00'）
 * 语义固定为**北京时间（Asia/Shanghai）**，与机器本地时区无关。
 *
 * 为什么这样做：
 *   原实现用 getFullYear()/getHours() 格式化、用 new Date(str) 解析，
 *   两者都依赖「浏览器本地时区」。而 mosaic 头部又手写 setUTCHours(+8)。
 *   结果只在「系统时区 = 东八区」时自洽；部署到 UTC 容器或海外机器后，
 *   时间轴的「最新时次」会整体错 8 小时，且同屏出现两套时间语义。
 *
 * ★ 新增时间格式需求请在本文件扩展，禁止在业务文件里再写一份。★
 */

/** 平台统一展示时区（中国气象数据按北京时间存储） */
export const PLATFORM_TZ = 'Asia/Shanghai';

/** 两位补零（00~99） */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 'sv-SE' 的格式恰好是 'YYYY-MM-DD HH:mm:ss'，省去手工拼装与补零 */
const ISO_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: PLATFORM_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

/**
 * 毫秒时间戳 → 目标时区相对 UTC 的偏移（毫秒）。
 * 用「把 UTC 时刻按目标时区格式化，再当作 UTC 解析」的差值求得。
 */
function tzOffsetMs(utcMs: number): number {
  const parts = ISO_FORMATTER.formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    map.year, map.month - 1, map.day,
    map.hour % 24, map.minute, map.second
  );
  return asUtc - utcMs;
}

/**
 * 毫秒时间戳 → ISO 串（固定按北京时间输出，与机器时区无关）。
 *
 * @param ms          时间戳
 * @param withSeconds 是否输出秒位。false 时秒固定为 00
 *                    （时间轴/配置时刻均为整分钟语义，避免秒位造成查不到文件）
 */
export function msToISO(ms: number, withSeconds = false): string {
  if (!Number.isFinite(ms)) return '';
  const text = ISO_FORMATTER.format(new Date(ms)).replace(' ', 'T');
  return withSeconds ? text : `${text.slice(0, 16)}:00`;
}

/**
 * 毫秒时间戳 → 显示文本 'YYYY-MM-DD HH:mm[:ss]'（画布/提示文字用）。
 */
export function msToText(ms: number, withSeconds = false): string {
  return msToISO(ms, withSeconds).replace('T', ' ');
}

/** ISO 串 → 毫秒；非法串返回 NaN（与 new Date().getTime() 行为一致） */
export function isoToMs(iso: string): number {
  if (!iso) return NaN;
  // 已显式带时区（Z / ±HH:mm）的串交给原生解析，不做二次换算
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) return new Date(iso).getTime();

  const naive = iso.replace(' ', 'T');
  // 先当作 UTC 解析，再减去该时刻在目标时区的偏移，得到真实时间戳。
  // 不能用 new Date(naive)：它按**浏览器本地时区**解释，正是错 8 小时的根源。
  const asUtc = Date.parse(`${naive}Z`);
  if (Number.isNaN(asUtc)) return NaN;
  return asUtc - tzOffsetMs(asUtc);
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
