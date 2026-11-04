<!--
  FolderFiles.vue —— 左侧侧栏「文件夹文件」区块

  功能：
    - 「选择文件夹」：调起系统文件夹选择器（input[webkitdirectory]），
      递归收集所选目录内的雷达数据文件（.bin / .m4 / .bz2，与屏头上传 accept 一致）；
    - 按文件自带的相对路径（webkitRelativePath）还原**目录层级树**：
      目录可展开/折叠，默认全部展开；文件显示大小；
    - 点击文件 → 经 uploadRouter 交给当前激活屏解析渲染（等同「上传」）。
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { appState, setLocalFileTimes } from '../store/appStore';
import { uploadToScreen } from '../composables/uploadRouter';
import { setLocalFolderFiles } from '../api/localFiles';

/** 文件夹中的一个可加载文件；File 内容延迟读取，不占内存 */
interface FolderEntry {
  file: File;
  /** 相对所选文件夹的路径（含子目录），用于还原层级 */
  relPath: string;
}

/** 目录树节点（仅用于把相对路径组织成层级） */
interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: { name: string; file: File }[];
  /** 该目录下（含子目录）文件总数 */
  total: number;
}

/** 扁平化后的可见节点：目录或文件，depth 用于缩进 */
interface FlatNode {
  key: string;
  name: string;
  depth: number;
  isDir: boolean;
  childCount: number;
  file: File | null;
}

const folderName = ref('');
const entries = ref<FolderEntry[]>([]);
const inputRef = ref<HTMLInputElement | null>(null);
/** 已折叠的目录路径集合（默认空 = 全部展开） */
const collapsed = ref<Set<string>>(new Set());

/** 与屏头上传 accept 一致：只收集 parseUploadedFile 能解析的格式（含 .bz2 压缩分发） */
function isRadarFile(name: string): boolean {
  return /\.(bin|m4|bz2)$/i.test(name);
}

/** 打开系统文件夹选择器（需用户手势，故用 ref 触发隐藏 input 的 click） */
function onPickFolder(): void {
  inputRef.value?.click();
}

/** 取文件的相对路径：webkitdirectory 给 webkitRelativePath，否则退化为文件名 */
function relPathOf(f: File): string {
  return (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
}

/** 选择文件夹后：过滤 + 登记本地文件源 + 重建层级树 */
function onFolderChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // 立即清空，允许下次重新选择同一文件夹
  input.value = '';
  // 重新选择目录时重置折叠状态，避免旧路径残留
  collapsed.value = new Set();

  if (files.length === 0) {
    folderName.value = '';
    entries.value = [];
    // 清空本地文件源：时间轴刻度同步消失
    setLocalFolderFiles([]);
    setLocalFileTimes([]);
    return;
  }

  // 文件夹名取首个文件相对路径的第一段（webkitRelativePath = "文件夹/子目录/文件"）
  folderName.value = relPathOf(files[0]).split('/')[0] ?? '';

  const radarFiles = files.filter((f) => isRadarFile(f.name));
  entries.value = radarFiles
    .map((f) => ({ file: f, relPath: relPathOf(f) }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  // 登记本地文件源：时间轴据此显示“有文件”刻度，选中时次后直接解析本地文件
  const metas = setLocalFolderFiles(radarFiles);
  setLocalFileTimes(metas.map((m) => m.time));
}

/** 递归统计目录下（含子目录）文件数 */
function countFiles(node: DirNode): number {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countFiles(d);
  node.total = n;
  return n;
}

/** 目录树（随 entries 变化重建） */
const tree = computed<DirNode>(() => {
  const root: DirNode = { name: '', path: '', dirs: new Map(), files: [], total: 0 };
  for (const e of entries.value) {
    const parts = e.relPath.split('/');
    const fileName = parts.pop() ?? e.file.name;
    let cur = root;
    for (const part of parts) {
      const path = cur.path ? cur.path + '/' + part : part;
      let next = cur.dirs.get(part);
      if (!next) {
        next = { name: part, path, dirs: new Map(), files: [], total: 0 };
        cur.dirs.set(part, next);
      }
      cur = next;
    }
    cur.files.push({ name: fileName, file: e.file });
  }
  countFiles(root);
  return root;
});

/** 按当前折叠状态输出可见节点（目录在前、同类按名称排序） */
const visibleNodes = computed<FlatNode[]>(() => {
  const out: FlatNode[] = [];
  const walk = (node: DirNode, depth: number): void => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      out.push({
        key: dir.path,
        name: dir.name,
        depth,
        isDir: true,
        childCount: dir.total,
        file: null
      });
      if (!collapsed.value.has(dir.path)) walk(dir, depth + 1);
    }
    const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of files) {
      out.push({
        key: node.path ? node.path + '/' + f.name : f.name,
        name: f.name,
        depth,
        isDir: false,
        childCount: 0,
        file: f.file
      });
    }
  };
  walk(tree.value, 0);
  return out;
});

/** 展开 / 折叠目录 */
function toggleDir(key: string): void {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}

/** 点击文件 → 交给激活屏渲染 */
function onLoadEntry(file: File | null): void {
  if (file) uploadToScreen(appState.activeScreenId, file);
}

/** 格式化文件大小（B / KB / MB） */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

/** 激活屏展示序号（与产品列表「作用于第 n 屏」一致） */
const activeIndex = computed(() => {
  const i = appState.screens.findIndex((s) => s.id === appState.activeScreenId);
  return i >= 0 ? i + 1 : 1;
});
</script>

<template>
  <div class="folder-panel">
    <div class="panel-title">
      文件夹文件
      <span class="panel-sub">作用于第 {{ activeIndex }} 屏</span>
    </div>

    <button class="btn folder-pick" @click="onPickFolder">选择文件夹</button>

    <!-- 隐藏的文件夹选择输入：webkitdirectory 递归收集所选目录内全部文件 -->
    <input
      ref="inputRef"
      type="file"
      webkitdirectory
      multiple
      hidden
      @change="onFolderChange"
    />

    <div v-if="folderName" class="folder-name" :title="folderName">{{ folderName }}</div>

    <p v-if="folderName && entries.length === 0" class="folder-empty">
      该文件夹内没有可加载的雷达文件（.bin / .m4 / .bz2）
    </p>

    <!-- 目录层级树：按缩进还原文件夹结构，目录可折叠 -->
    <ul v-if="visibleNodes.length" class="folder-list">
      <li v-for="n in visibleNodes" :key="n.key">
        <button
          v-if="n.isDir"
          class="folder-dir"
          :style="{ paddingLeft: 6 + n.depth * 14 + 'px' }"
          :title="n.key"
          @click="toggleDir(n.key)"
        >
          <span class="folder-caret">{{ collapsed.has(n.key) ? '▸' : '▾' }}</span>
          <span class="folder-dir-name">{{ n.name }}</span>
          <span class="folder-item-size">{{ n.childCount }}</span>
        </button>

        <button
          v-else
          class="folder-item"
          :style="{ paddingLeft: 6 + n.depth * 14 + 'px' }"
          :title="n.key"
          @click="onLoadEntry(n.file)"
        >
          <span class="folder-item-name">{{ n.name }}</span>
          <span class="folder-item-size">{{ n.file ? formatSize(n.file.size) : '' }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
