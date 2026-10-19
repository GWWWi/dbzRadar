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
import { msToISO } from '../utils/datetime';
import { fetchWithTimeout } from '../utils/http';

/** 配置文件地址（默认站点 /data/config.json，可用 setConfigUrl 改指向） */
let configUrl = 'data/config.json';

/** 设置配置文件地址（相对站点根的路径或任意服务器的绝对 URL） */
export function setConfigUrl(url: string): void {
  configUrl = url;
}

/**
 * 时间轴时次上限。
 *
 * 取值依据：默认配置 6 分钟 × 10 天 = 2401 档，必须保持不变（3000 留出余量）；
 * 误配 1 分钟 × 10 天 = 14400 档时放大到 5 分钟（2881 档）。
 * 上限的作用是防止绘制/播放/文件探测成本随时次数线性膨胀。
 */
const MAX_TIMELINE_POINTS = 3000;

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
    // 超时后进入 catch → 返回 null → 上层回退清单模式，不会卡在启动阶段
    const resp = await fetchWithTimeout(configUrl);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const cfg = normalizeConfig(await resp.json());
    if (!cfg) throw new Error('配置结构非法');
    return cfg;
  } catch (e) {
    console.warn('[configApi] 配置(' + configUrl + ')加载失败，回退清单模式：', e);
    return null;
  }
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
  const baseStepMs = Math.max(1, cfg.timeline.intervalMinutes) * 60000;
  // 锚点取整到分钟，保证时刻串秒位为 00
  const nowMs = Math.floor(anchorMs / 60000) * 60000;
  const startMs =
    cfg.timeline.mode === 'fcst' ? nowMs : nowMs - cfg.timeline.lookbackDays * 86400000;
  const endMs = cfg.timeline.mode === 'fcst' ? nowMs + cfg.timeline.forecastHours * 3600000 : nowMs;

  // —— 时次数保护 ——
  // 时次过多会让时间轴绘制、播放推进、文件探测成本线性上升
  // （典型误配：intervalMinutes=1 + lookbackDays=10 → 14400 档）。
  // 这里保持“整分钟、从 start 到 end”的语义，只放大步长并告警，
  // 不截断时间轴（截断会让用户看不到最新时次）。
  const spanMs = Math.max(0, endMs - startMs);
  const minStepMs = Math.ceil(spanMs / (MAX_TIMELINE_POINTS - 1) / 60000) * 60000;
  const stepMs = Math.max(baseStepMs, minStepMs);
  if (stepMs > baseStepMs) {
    console.warn(
      `[configApi] 时间轴时次超过 ${MAX_TIMELINE_POINTS} 个，间隔由 ` +
        `${cfg.timeline.intervalMinutes} 分钟放大到 ${stepMs / 60000} 分钟`
    );
  }

  const times: string[] = [];
  // 时刻串统一由 utils/datetime 生成（秒固定 00），保证与文件模板/控件同源
  for (let t = startMs; t <= endMs; t += stepMs) times.push(msToISO(t));
  return times;
}

/**
 * 获取当前产品最新时间（接口约定，★ 当前为假数据实现）。
 * 假数据：直接返回当前时间（取整到分钟的 ISO 串）。
 * 后端接入时替换为真实请求（如 GET /api/radar/latest?product={productId}）。
 *
 * @param productId 产品代码（假数据暂未区分产品，保留参数以匹配真实接口签名）
 * @returns 最新时刻 ISO 串 'yyyy-MM-ddTHH:mm:00'
 */
export async function fetchLatestTime(productId: string): Promise<string> {
  void productId;
  return msToISO(Date.now());
}

/**
 * 把任意时刻吸附到时间轴上最近的时次（times 为空时原样返回 target）。
 * 用于"最新时间"等接口返回值不在时间轴上时，保证赋值的时次有效。
 */
export function snapNearestTime(times: string[], target: string): string {
  if (!times.length) return target;
  const t = new Date(target).getTime();
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (new Date(times[mid]).getTime() < t) lo = mid + 1;
    else hi = mid;
  }
  const near =
    lo > 0 && t - new Date(times[lo - 1]).getTime() <= new Date(times[lo]).getTime() - t
      ? times[lo - 1]
      : times[lo];
  return near;
}
