/**
 * constants/messages.ts —— 反馈类提示文案的唯一来源
 *
 * ★ 为什么集中 ★
 *   屏头状态与各类失败提示此前是散落在 composables / 组件里的字符串字面量，
 *   与 docs/USER_GUIDE.md §6 的状态对照表靠人肉同步，改一处忘一处就会出现
 *   “界面说法”与“手册说法”不一致（现场排查时最容易被误导的一类问题）。
 *   这里一处定义：界面与手册共用同一套措辞。
 *
 * ★ 与 src/constants.ts 的分工 ★
 *   constants.ts 只放影响数据正确性的数值哨兵（UNDEF）；
 *   本文件只放用户看得见的提示文案，不参与任何计算。
 *
 * ★ 文案（text）与语气（kind）分开 ★
 *   「加载中…」与「加载失败」长度相近但严重程度完全不同，
 *   屏头按 kind 决定配色，读屏器据此播报。
 *
 * 范围：只收纳“反馈类”提示（屏头状态 / toast / 空态与校验提示）。
 * 按钮文字、面板标题、悬停 tooltip 属于界面标签，仍留在各自组件里。
 */

import type { RadarFileFormat, RadarQuerySource } from '../types';

/** 屏头状态语气：决定配色与读屏播报强弱 */
export type ScreenStatusKind = 'info' | 'busy' | 'warn' | 'error';

/**
 * 屏头状态文案。
 * 与 docs/USER_GUIDE.md §6 状态对照表逐条对应，改这里必须同步改手册。
 */
export const STATUS = {
  /** 正在下载 / 解析该时次文件 */
  loading: '加载中…',
  /** 正在识别用户上传的文件 */
  recognizing: '识别中…',
  /** 该时刻没有对应文件（清单模式会追加“最近可用”时次） */
  noData: '该时次无数据',
  /** 取数 / 解析失败（含请求超时） */
  loadFailed: '加载失败',
  /** 仅上传模式：切时次后画面为空是预期行为，必须解释 */
  uploadModeHint: '仅上传模式：点屏头「上传」加载文件',
  /** 上传失败兜底（非 UploadFileError 的意外错误） */
  uploadFailed: '上传失败',
  /** 上传失败：超过 200MB 上限 */
  fileTooLarge: '文件过大',
  /** 上传失败：bz2 解压失败（文件损坏或被截断） */
  fileCorrupt: '文件损坏',
  /** 上传失败：不是受支持的格式 */
  wrongFormat: '文件格式不符',
  /** 上传失败：格式对但解不出有效数据 */
  noValidData: '无有效数据'
} as const;

/**
 * 上传数据在屏头的“来源标签”。
 * 与状态文本分开：上传的合成文件需要同时显示来源与「示意数据」警示。
 */
export function uploadDataLabel(fileName: string): string {
  return '上传数据 · ' + fileName;
}

/**
 * 「该时次无数据」的完整文案。
 * 已知最近可用时次时一并给出，用户不必自己一个个试。
 */
export function noDataText(nearest: string): string {
  return nearest ? `${STATUS.noData}（最近可用 ${nearest}）` : STATUS.noData;
}

/** 上传结果提示（成功 / 合成兜底 / 兜底失败） */
export const UPLOAD_MSG = {
  /** 真实解码成功 */
  ok: (fileName: string) => `文件识别成功：${fileName}`,
  /** 合成兜底：文件加载了，但画面不是真实数据 */
  synthetic: (fileName: string) =>
    `文件已加载但未能真实解码（画面为示意数据）：${fileName}`,
  /** 异常对象不是 Error 时的兜底文案 */
  failed: '上传文件解析失败'
} as const;

/** 部署更新检测提示 */
export const VERSION_MSG = {
  /** 自动刷新过一次仍不一致（多为 index.html 被缓存），提示手动硬刷新 */
  stale: '检测到新版本，但页面仍是旧内容，请按 Ctrl+F5 强制刷新',
  /** 即将自动刷新 */
  updating: '检测到系统已更新，正在刷新页面…'
} as const;

/** 时间轴提示 */
export const TIMELINE_MSG = {
  /** 时间轴一个时次都没有：不能用“1 / 0 时次”这种自相矛盾的计数 */
  empty: '无可用时次',
  /** 空时间轴的悬停说明（指向最可能的两个原因） */
  emptyTip: '数据服务未返回任何时次，请检查产品目录、清单或 config.json 是否可访问'
} as const;

/** 应用初始化提示 */
export const APP_MSG = {
  /** 启动时产品目录 / 配置 / 清单全部拉取失败（产品目录自身有静态回退） */
  initFailed: '应用初始化失败，请检查数据服务是否可用',
  /**
   * dataSourceMode=latest 但没有 fileUrlTemplate：无法按最新时间定位文件，
   * 每个时次都会显示“该时次无数据”。此前只有 console.warn，界面上完全看不出原因。
   */
  latestNoTemplate: '配置为 latest 模式但缺少 fileUrlTemplate，无法定位数据文件，请检查 config.json'
} as const;

/**
 * 坐标查询面板与地图弹窗共用的标签。
 * 两处展示同一组数值，标签必须逐字一致，否则会被当成两种口径。
 */
export const QUERY_LABEL = {
  raw: '原始',
  mean9: '9 点均值',
  /** 结果里“数据来源”那一行的前缀 */
  source: '来源'
} as const;

/* ───────────────── 坐标查询：数据来源与取值口径说明 ───────────────── */

/** 来源短标签（面板一行 / 弹窗一行共用） */
const SOURCE_LABEL = {
  rstmVolume: (elev: number) => `RSTM 基数据 ${elev.toFixed(1)}°（原始径向）`,
  rstmSingle: 'RSTM 单层格点（最近邻取值）',
  rstmSynthetic: 'RSTM 合成兜底（示意数据，非实测）',
  m4: 'MICAPS m4 格点（最近邻取值）',
  mosaic: 'SWAN 拼图格点（最近邻取值）',
  unknown: '来源未知'
} as const;

/**
 * 「为什么同一位置换个文件数值不同」的完整解释。
 *
 * ★ 这段是给现场答疑用的 ★
 *   手册与排查记录里反复出现“m4 与 bz2 同点数值不一致是不是 bug”，
 *   本质是数据产品不同（格点产品 vs 单仰角原始基数据），不是取值实现问题。
 */
export const QUERY_DIFF_TIP =
  '同一位置在不同文件下数值不同，通常不是取值出错：' +
  'MICAPS m4 与 SWAN 拼图是服务端经多仰角合成、平滑插值后的格点产品，按最近格点取值（约 1km 量化），且没有 9 点均值；' +
  'RSTM 是单站单仰角的原始基数据，按原始径向库取值（无格点量化），换仰角即换高度。';

/** 合成兜底数据的解释（数值完全不可用） */
const SYNTHETIC_TIP =
  '该文件未能真实解码，画面与数值都由程序生成的演示团块给出，禁止用于任何业务判断。';

/** querySourceOf 的输入 */
export interface QuerySourceInput {
  /** 当前数据格式（无法判定时传 null） */
  format: RadarFileFormat | null;
  /** 是否为 RSTM 基数据体（有仰角层） */
  isVolume: boolean;
  /** 是否为合成兜底（示意数据） */
  isSynthetic: boolean;
  /** 当前仰角（度）；非体数据传 -1 */
  elevation: number;
  /** 是否为 .bz2 压缩包（只影响传输，不影响数值，需点明避免误判） */
  compressed?: boolean;
}

/**
 * 组装坐标查询的“来源 + 口径”说明。
 * @returns label=一行短标签（面板/弹窗），tip=完整解释（悬停 / 折叠展开）
 */
export function querySourceOf(input: QuerySourceInput): RadarQuerySource {
  const { format, isVolume, isSynthetic, elevation, compressed } = input;

  let label: string;
  if (isSynthetic) label = SOURCE_LABEL.rstmSynthetic;
  else if (isVolume) label = SOURCE_LABEL.rstmVolume(elevation >= 0 ? elevation : 0);
  else if (format === 'm4') label = SOURCE_LABEL.m4;
  else if (format === 'mosaic') label = SOURCE_LABEL.mosaic;
  else if (format === 'rstm') label = SOURCE_LABEL.rstmSingle;
  else label = SOURCE_LABEL.unknown;

  let tip = isSynthetic ? SYNTHETIC_TIP : QUERY_DIFF_TIP;
  // .bz2 与解压后的文件数值完全一致；不点明会被当成“后缀不同结果不同”
  if (compressed) tip += '本文件是 .bz2 压缩包，数值与解压后的同名文件完全一致。';

  return { label, tip };
}

/** 左侧「文件夹文件」区块提示 */
export const FOLDER_MSG = {
  /** 选中的目录里没有可识别文件（此前同一句在两个入口各写一份） */
  noRadarFile: '该文件夹内没有可识别的雷达文件（需 .bin/.m4/.bz2 且文件名含 14 位时刻）',
  /** 目录句柄授权成功并重新枚举完成 */
  restored: '已恢复上次文件夹',
  /** 有句柄但授权失败 / 目录已不可访问 */
  restoreFailed: '无法自动恢复，请点击「选择文件夹」重新选择',
  /** 记忆占位的文件（无真实 File 对象）被点击 */
  pendingEntry: '该文件来自上次记忆，请重新选择该文件夹或点击「恢复」后再加载',
  /** 空态：有目录授权记忆，下次打开会自动恢复 */
  empty: '尚未选择文件夹（可多次选择累加，下次打开会自动恢复）',
  /**
   * 空态：无授权记忆（http 局域网 / 非 Chromium）。
   * ★ 必须与上方环境提示一致 ★ 原文写“下次打开仍会记住”，
   * 而同一屏的环境提示写“下次打开需重新选择”，两句自相矛盾。
   */
  emptyNoRestore: '尚未选择文件夹（可多次选择累加；本环境刷新后需重新选择）'
} as const;
