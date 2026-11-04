/**
 * api/localFiles.ts —— 本地文件夹文件源（仅内存，当前会话有效）
 *
 * 左侧「文件夹文件」选择目录后把可解析文件登记到这里：
 *   - 时间轴据此显示“有文件”的绿色刻度，并可跳转 / 步进到这些时次；
 *   - 取数时 useRadarScreen 优先用本地 File 解析，不请求服务器。
 *
 * 只保留最近一次选择的目录（重新选择会整体替换，旧 File 引用随之释放）。
 * 本模块不持有响应式状态：时间轴需要的时次由 store.localFileTimes 驱动。
 */

import type { RadarFileMeta } from '../types';
import { buildMetaFromFileName } from './radarManifest';

/** 本地文件登记项：清单元信息 + 原始 File */
interface LocalFileEntry {
  meta: RadarFileMeta;
  file: File;
}

/** 当前目录的本地文件 */
let entries: LocalFileEntry[] = [];
/** 时次 → File 索引（取数用） */
let byTime = new Map<string, File>();

/**
 * 登记一次文件夹选择的结果。
 *
 * 文件名必须含 14 位时刻（yyyyMMddHHmmss）才能参与时间轴与按时间取数；
 * 无法识别时刻的文件不登记（仍可在列表里手动点击上传）。
 *
 * @param files 所选目录内的文件（调用方已按可解析扩展名过滤）
 * @returns 成功识别时次的清单项（供时间轴 / 列表展示）
 */
export function setLocalFolderFiles(files: File[]): RadarFileMeta[] {
  entries = [];
  byTime = new Map();
  for (const file of files) {
    const meta = buildMetaFromFileName(file.name);
    if (!meta) continue;
    entries.push({ meta, file });
    byTime.set(meta.time, file);
  }
  return entries.map((e) => e.meta);
}

/** 取某个时次对应的本地文件；没有则返回 null */
export function getLocalFile(time: string): File | null {
  return byTime.get(time) ?? null;
}

/** 当前已登记的本地文件清单项（调试 / 展示用） */
export function getLocalFolderMetas(): RadarFileMeta[] {
  return entries.map((e) => e.meta);
}
