/**
 * api/localFiles.ts —— 本地文件夹文件源（含跨会话结构记忆）
 *
 * 左侧「文件夹文件」每选择一次目录就**追加**一组（顶层文件夹 = 一个父级节点），
 * 支持多组并存、按组删除：
 *   - 时间轴据此显示“有文件”的绿色刻度，并可跳转 / 步进到这些时次；
 *   - 取数时 useRadarScreen 优先用本地 File 解析，不请求服务器。
 *
 * ★ 跨会话记忆的两层含义 ★
 *   1) 文件夹**结构**（组名 / 文件名 / 大小 / 时次）写入 localStorage：
 *      下次打开浏览器可直接看到上次添加的文件夹（展开可查看文件清单）。
 *   2) 文件**内容**（File）无法持久化 —— File 是浏览器安全对象，不能写入
 *      localStorage / IndexedDB。因此恢复出来的组是“占位”（ready=false），
 *      点击文件会提示重新选择该文件夹；重新选择同名目录时自动替换为真实文件。
 *
 * ★ 为什么是“追加”而不是“替换” ★
 *   用户会分多次选择不同目录（不同日期 / 不同站点），替换会让上一次的选择凭空消失。
 */

import type { RadarFileMeta } from '../types';
import { buildMetaFromFileName } from './radarManifest';

/** 一个待登记文件：原始 File + 相对所选文件夹的路径（含顶层文件夹名） */
export interface LocalFileItem {
  file: File;
  relPath: string;
}

/** 组内一条文件记录 */
export interface LocalEntry {
  meta: RadarFileMeta;
  /** 真实文件；null = 记忆占位（需重新选择文件夹后才能加载） */
  file: File | null;
  relPath: string;
  /** 文件大小（占位时来自记忆） */
  size: number;
}

/** 一组文件夹选择（顶层文件夹 = 一个父级节点） */
export interface LocalFolderGroup {
  /** 唯一 id（用于删除与渲染 key） */
  id: number;
  /** 顶层文件夹名 */
  name: string;
  entries: LocalEntry[];
  /** 是否含真实文件：false = 仅从记忆恢复的结构，点击需重新选择 */
  ready: boolean;
}

/** localStorage 持久化结构（只存可展示信息，File 无法序列化） */
interface StoredGroup {
  id: number;
  name: string;
  files: { name: string; relPath: string; size: number; time: string }[];
}

/** localStorage 键：上次选择的文件夹结构 */
const STORE_KEY = 'radar:local-folders';

/** 已选择的全部组（按选择先后顺序） */
let groups: LocalFolderGroup[] = [];
/** 组 id 自增（删除后不复用，避免 key 冲突） */
let nextGroupId = 1;
/** 时次 → File 索引（仅真实文件；add / remove / restore 后整体重建） */
let byTime = new Map<string, File>();

/** 重建时次索引：多组时次冲突时，后加入的组优先 */
function rebuild(): void {
  byTime = new Map();
  for (const g of groups) {
    for (const e of g.entries) {
      if (e.file) byTime.set(e.meta.time, e.file);
    }
  }
}

/** 持久化文件夹结构（记忆失败不影响当前会话） */
function persist(): void {
  try {
    const stored: StoredGroup[] = groups.map((g) => ({
      id: g.id,
      name: g.name,
      files: g.entries.map((e) => ({
        name: e.file?.name ?? e.relPath.split('/').pop() ?? '',
        relPath: e.relPath,
        size: e.size,
        time: e.meta.time
      }))
    }));
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {
    // 隐私模式 / 配额不足：忽略
  }
}

/** 读取持久化的文件夹结构 */
function readStored(): StoredGroup[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as StoredGroup[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * 恢复上次选择的文件夹（应用启动时调用一次）。
 *
 * 只恢复结构（组名 / 文件名 / 大小 / 时次），文件内容需用户重新选择目录后才能加载；
 * 因此恢复出来的组 ready=false，不参与按时间取值。
 */
export function restoreLocalFolders(): void {
  const stored = readStored();
  if (stored.length === 0) return;

  groups = stored.map((s) => ({
    id: s.id,
    name: s.name,
    ready: false,
    entries: s.files.map((f) => ({
      // 占位 meta：只用于树形展示（文件名 / 时次），不参与取数
      meta: {
        file: f.name,
        binFile: f.name,
        time: f.time,
        stationId: '',
        stationName: '',
        hasData: true,
        format: 'rstm'
      } as RadarFileMeta,
      file: null,
      relPath: f.relPath,
      size: f.size
    }))
  }));
  nextGroupId = groups.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  rebuild();
}

/**
 * 追加一组文件夹文件（不清空已有组）。
 *
 * 若存在同名且仅有记忆结构的组（ready=false），用本次真实文件替换它 ——
 * 这样“重新选择同一目录”即可恢复上次记忆的文件夹，不会出现重复条目。
 *
 * @param items 所选目录内的雷达文件（含相对路径；调用方已按扩展名过滤）
 * @returns 新增 / 被恢复的组；没有可识别文件时返回 null
 */
export function addLocalFolder(items: LocalFileItem[]): LocalFolderGroup | null {
  if (items.length === 0) return null;

  const name = (items[0].relPath.split('/')[0] || '').trim() || '未命名文件夹';
  const entries: LocalEntry[] = [];
  for (const item of items) {
    const meta = buildMetaFromFileName(item.file.name);
    if (!meta) continue;
    entries.push({ meta, file: item.file, relPath: item.relPath, size: item.file.size });
  }
  if (entries.length === 0) return null;

  const pending = groups.find((g) => !g.ready && g.name === name);
  if (pending) {
    pending.entries = entries;
    pending.ready = true;
    rebuild();
    persist();
    return pending;
  }

  const group: LocalFolderGroup = { id: nextGroupId++, name, entries, ready: true };
  groups.push(group);
  rebuild();
  persist();
  return group;
}

/** 删除一个组的全部文件（父级节点后的“删除”按钮） */
export function removeLocalFolder(id: number): void {
  groups = groups.filter((g) => g.id !== id);
  rebuild();
  persist();
}

/** 已选择的全部组快照（供 UI 渲染；数组为副本，元素只读） */
export function getLocalGroups(): LocalFolderGroup[] {
  return groups.slice();
}

/** 全部组的时次并集（升序；只含可加载的真实文件） */
export function getLocalFileTimes(): string[] {
  return Array.from(byTime.keys()).sort();
}

/** 取某个时次对应的本地文件；没有则返回 null */
export function getLocalFile(time: string): File | null {
  return byTime.get(time) ?? null;
}
