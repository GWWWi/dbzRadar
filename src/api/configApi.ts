/**
 * api/configApi.ts —— 应用配置接口（时间轴规则 + 文件地址）
 *
 * ────────────────────────────────────────────────────────────────────────
 * 职责：
 *   1) fetchAppConfig()：从服务器拉取 config.json（地址可用 setConfigUrl
 *      指向任意目录）。配置决定：
 *        - 时间轴：提前按规则生成，与实际文件无关
 *            · 实况 obs ：当前时间为结束时间，往前推 lookbackDays 天
 *            · 预报 fcst：当前时间起，加上 forecastHours 小时时效
 *            · 间隔 intervalMinutes，以分钟为基准
 *        - 文件路径：fileUrlTemplate 模板（{time} → yyyyMMddHHmmss）
 *          优先；否则用 fileListUrl 清单按时间精确匹配。
 *   2) buildTimelineTimes(cfg)：按配置生成升序时刻串（ISO 格式）。
 *
 * 容错：配置缺失/非法时返回 null，上层回退“清单模式”（时间轴取自清单），
 * 保证无配置部署（如本地 demo）行为不变。
 * ────────────────────────────────────────────────────────────────────────
 */

import type { AppConfig, TimelineConfig } from '../types';

/** 配置文件地址（默认站点 /data/config.json，可用 setConfigUrl 改指向） */
let configUrl = 'data/config.json';

/** 设置配置文件地址（相对站点根的路径或任意服务器的绝对 URL） */
export function setConfigUrl(url: string): void {
  configUrl = url;
}

/** 内置默认时间轴规则（配置文件缺字段时兜底） */
const DEFAULT_TIMELINE: TimelineConfig = {
  mode: 'obs',
  intervalMinutes: 6,
  lookbackDays: 10,
  forecastHours: 24
};

/**
 * 校验并规整服务器配置；结构非法时返回 null（上层回退清单模式）。
 */
function normalizeConfig(raw: unknown): AppConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const t = (r.timeline ?? {}) as Record<string, unknown>;
  const mode = t.mode === 'fcst' ? 'fcst' : 'obs';
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  const timeline: TimelineConfig = {
    mode,
    intervalMinutes: num(t.intervalMinutes, DEFAULT_TIMELINE.intervalMinutes),
    lookbackDays: num(t.lookbackDays, DEFAULT_TIMELINE.lookbackDays),
    forecastHours: num(t.forecastHours, DEFAULT_TIMELINE.forecastHours)
  };
  const fileUrlTemplate = typeof r.fileUrlTemplate === 'string' ? r.fileUrlTemplate : '';
  const fileListUrl = typeof r.fileListUrl === 'string' && r.fileListUrl ? r.fileListUrl : 'data/manifest.json';
  return { timeline, fileUrlTemplate, fileListUrl };
}

/**
 * 获取应用配置。
 * @returns 合法配置；缺失/非法时返回 null（上层回退清单模式）
 */
export async function fetchAppConfig(): Promise<AppConfig | null> {
  try {
    const resp = await fetch(configUrl);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const cfg = normalizeConfig(await resp.json());
    if (!cfg) throw new Error('配置结构非法');
    return cfg;
  } catch (e) {
    console.warn('[configApi] 配置(' + configUrl + ')加载失败，回退清单模式：', e);
    return null;
  }
}

/** Date → ISO 时刻串 'yyyy-MM-ddTHH:mm:00'（秒固定为 00） */
function fmtISO(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

/**
 * 按配置生成时间轴（升序，毫秒对齐到整分钟）：
 *   obs ：[anchor - lookbackDays 天, anchor]，间隔 intervalMinutes；
 *   fcst：[anchor, anchor + forecastHours 小时]，间隔 intervalMinutes。
 * 锚点默认当前时间（实况=结束时间，预报=起报时间），可由时间轴上的
 * 时间选择控件指定后重新生成。
 *
 * @param cfg      应用配置
 * @param anchorMs 锚点毫秒时间戳，默认当前时间
 */
export function buildTimelineTimes(cfg: AppConfig, anchorMs: number = Date.now()): string[] {
  const stepMs = Math.max(1, cfg.timeline.intervalMinutes) * 60000;
  // 锚点取整到分钟，保证时刻串秒位为 00
  const nowMs = Math.floor(anchorMs / 60000) * 60000;
  const startMs =
    cfg.timeline.mode === 'fcst' ? nowMs : nowMs - cfg.timeline.lookbackDays * 86400000;
  const endMs = cfg.timeline.mode === 'fcst' ? nowMs + cfg.timeline.forecastHours * 3600000 : nowMs;

  const times: string[] = [];
  for (let t = startMs; t <= endMs; t += stepMs) times.push(fmtISO(t));
  return times;
}
