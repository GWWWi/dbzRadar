/**
 * api/localFiles.ts —— 本地文件夹文件源（跨会话记忆 / 自动恢复）
 *
 * 左侧「文件夹文件」每选择一次目录就**追加**一组（顶层文件夹 = 一个父级节点），
 * 支持多组并存、按组删除：
 *   - 时间轴据此显示“有文件”的绿色刻度，并可跳转 / 步进到这些时次；
 *   - 取数时 useRadarScreen 优先用本地 File 解析，不请求服务器。
 *
 * ★ 跨会话记忆的两条路径 ★
 *   1) 结构记忆（任何环境）：组名 / 文件名 / 大小 / 时次写入 localStorage，
 *      下次打开可直接看到上次的文件夹结构（占位，`ready=false`）。
 *   2) 句柄记忆（File System Access API + https/localhost + Chromium）：
 *      保存 `FileSystemDirectoryHandle` 到 IndexedDB，下次打开若权限仍为 granted
 *      则**自动重新枚举文件**，无需任何操作；若为 prompt，则 UI 上点一次「恢复」即可。
 *
 * ★ 为什么 File 不能直接持久化 ★
 *   File 是浏览器安全对象，不能写入 localStorage / IndexedDB；句柄才是可持久化的“钥匙”。
 */

import type { RadarFileMeta } from '../types';
import { buildMetaFromFileName } from './radarManifest';
import { loadDirHandles, saveDirHandles } from './localFileStore';

/** 一个待登记文件：原始 File + 相对所选文件夹的路径（含顶层文件夹名） */
export interface LocalFileItem {
  file: File;
  relPath: string;
}

/** 组内一条文件记录 */
export interface LocalEntry {
  meta: RadarFileMeta;
  /** 真实文件；null = 记忆占位（需重新选择文件夹或点「恢复」授权后才能加载） */
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
  /** 是否含真实文件：false = 占位（结构可看，文件不可加载） */
  ready: boolean;
  /** 目录句柄（File System Access API 获得；用于下次自动恢复） */
  handle?: FileSystemDirectoryHandle;
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

/** 可解析的雷达文件扩展名（与屏头上传 accept 一致，含 .bz2 压缩分发） */
export function isRadarFileName(name: string): boolean {
  return /\.(bin|m4|bz2)$/i.test(name);
}

/** 重建时次索引：多组时次冲突时，后加入的组优先 */
function rebuild(): void {
  byTime = new Map();
  for (const g of groups) {
    for (const e of g.entries) {
      if (e.file) byTime.set(e.meta.time, e.file);
    }
  }
}

/** 把文件项转为组内记录（无法识别时次的文件丢弃） */
function toEntries(items: LocalFileItem[]): LocalEntry[] {
  const out: LocalEntry[] = [];
  for (const item of items) {
    const meta = buildMetaFromFileName(item.file.name);
    if (!meta) continue;
    out.push({ meta, file: item.file, relPath: item.relPath, size: item.file.size });
  }
  return out;
}

/**
 * 枚举目录句柄下的全部雷达文件（相对路径含顶层文件夹名）。
 * 供 File System Access API 路径使用；不支持时不会被调用。
 */
export async function collectDirFiles(handle: FileSystemDirectoryHandle): Promise<LocalFileItem[]> {
  const out: LocalFileItem[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const entry of dir.values()) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.kind === 'file') {
        if (!isRadarFileName(entry.name)) continue;
        const file = await (entry as FileSystemFileHandle).getFile();
        out.push({ file, relPath: rel });
      } else {
        await walk(entry as FileSystemDirectoryHandle, rel);
      }
    }
  };
  await walk(handle, handle.name);
  return out;
}

/** 持久化：结构写 localStorage，句柄写 IndexedDB（失败忽略，不影响当前会话） */
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

  const handles = groups
    .filter((g) => g.handle)
    .map((g) => ({ id: g.id, handle: g.handle as FileSystemDirectoryHandle }));
  void saveDirHandles(handles).catch(() => undefined);
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

/** 用记忆结构构造占位组（文件不可加载，仅用于展示） */
function makePlaceholder(s: StoredGroup, handle?: FileSystemDirectoryHandle): LocalFolderGroup {
  return {
    id: s.id,
    name: s.name,
    ready: false,
    handle,
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
  };
}

/**
 * 恢复上次选择的文件夹（应用启动时调用一次）。
 *
 * 优先用 IndexedDB 里的目录句柄重新枚举（权限 granted 时完全无需用户操作）；
 * 无句柄 / 未授权则退回结构占位（可看，点击时提示重新选择或点「恢复」）。
 */
export async function restoreLocalFolders(): Promise<void> {
  const stored = readStored();
  if (stored.length === 0) return;

  let handles: { id: number; handle: FileSystemDirectoryHandle }[] = [];
  try {
    handles = await loadDirHandles();
  } catch {
    // IndexedDB 不可用（隐私模式 / 老浏览器）→ 只恢复结构
  }
  const handleById = new Map(handles.map((h) => [h.id, h.handle]));

  const restored: LocalFolderGroup[] = [];
  for (const s of stored) {
    const handle = handleById.get(s.id);

    if (handle) {
      let granted = false;
      try {
        granted = (await handle.queryPermission?.({ mode: 'read' })) === 'granted';
      } catch {
        granted = false;
      }

      if (granted) {
        const entries = toEntries(await collectDirFiles(handle).catch(() => []));
        if (entries.length > 0) {
          restored.push({ id: s.id, name: s.name, entries, ready: true, handle });
          continue;
        }
      }
      // 有句柄但未授权：保留句柄，界面显示「恢复」（点一次授权即可）
      restored.push(makePlaceholder(s, handle));
      continue;
    }

    restored.push(makePlaceholder(s));
  }

  groups = restored;
  nextGroupId = groups.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  rebuild();
}

/**
 * 追加一组文件夹文件（不清空已有组）。
 *
 * 若存在同名且仅有记忆结构的组（ready=false），用本次真实文件替换它 ——
 * 这样“重新选择同一目录”即可恢复上次记忆的文件夹，不会出现重复条目。
 *
 * @param items  所选目录内的雷达文件（含相对路径；调用方已按扩展名过滤）
 * @param handle 目录句柄（File System Access API 路径传入，用于下次自动恢复）
 * @returns 新增 / 被恢复的组；没有可识别文件时返回 null
 */
export function addLocalFolder(
  items: LocalFileItem[],
  handle?: FileSystemDirectoryHandle
): LocalFolderGroup | null {
  if (items.length === 0) return null;

  const name = (items[0].relPath.split('/')[0] || '').trim() || handle?.name || '未命名文件夹';
  const entries = toEntries(items);
  if (entries.length === 0) return null;

  const pending = groups.find((g) => !g.ready && g.name === name);
  if (pending) {
    pending.entries = entries;
    pending.ready = true;
    if (handle) pending.handle = handle;
    rebuild();
    persist();
    return pending;
  }

  const group: LocalFolderGroup = { id: nextGroupId++, name, entries, ready: true, handle };
  groups.push(group);
  rebuild();
  persist();
  return group;
}

/**
 * 对某个占位组请求目录权限并重新读取文件（父级「恢复」按钮调用）。
 * 必须在用户手势中调用（requestPermission 的要求）。
 * @returns 是否恢复成功
 */
export async function restoreGroupFromHandle(id: number): Promise<boolean> {
  const group = groups.find((g) => g.id === id);
  const handle = group?.handle;
  if (!group || !handle) return false;

  try {
    const perm = await handle.requestPermission?.({ mode: 'read' });
    if (perm !== 'granted') return false;
    const entries = toEntries(await collectDirFiles(handle));
    if (entries.length === 0) return false;
    group.entries = entries;
    group.ready = true;
    rebuild();
    persist();
    return true;
  } catch {
    return false;
  }
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
