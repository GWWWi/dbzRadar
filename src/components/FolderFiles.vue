<!--
  FolderFiles.vue —— 左侧侧栏「文件夹文件」区块

  功能：
    - 「选择文件夹」：调起系统文件夹选择器（input[webkitdirectory]），
      递归收集所选目录内的雷达数据文件（.bin / .m4 / .bz2，与屏头上传 accept 一致）；
    - 多次选择**累加**：每个顶层文件夹是一个父级节点，互不覆盖；
    - **跨会话记忆**：下次打开浏览器仍能看到上次添加的文件夹结构（localStorage）；
      文件内容无法持久化，重新选择同名文件夹即恢复可加载状态（父级显示「需重选」）；
    - 父级节点后的「删除」可整组移除（只有点击删除才删除）；
    - 目录层级按 webkitRelativePath 还原，目录可展开/折叠；
    - 点击文件 → 经 uploadRouter 交给当前激活屏解析渲染（等同「上传」）。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { appState, setLocalFileTimes } from '../store/appStore';
import { uploadToScreen } from '../composables/uploadRouter';
import {
  addLocalFolder,
  getLocalFileTimes,
  getLocalGroups,
  removeLocalFolder,
  restoreLocalFolders
} from '../api/localFiles';
import type { LocalFolderGroup } from '../api/localFiles';

/** 目录树节点（组内子树，不含顶层文件夹名） */
interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: { name: string; file: File | null; size: number }[];
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
  /** 文件大小（占位时来自记忆） */
  size: number;
  groupId: number | null;
  /** 是否为顶层文件夹（父级节点，显示「删除」） */
  isGroupRoot: boolean;
  /** 所属组是否含真实文件（false = 记忆占位，点击需重新选择） */
  ready: boolean;
}

const groups = ref<LocalFolderGroup[]>([]);
const inputRef = ref<HTMLInputElement | null>(null);
/** 已折叠的目录 key 集合（默认空 = 全部展开） */
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

/** 把本地文件源的最新状态同步到 UI 与时间轴 */
function syncFromStore(): void {
  groups.value = getLocalGroups();
  setLocalFileTimes(getLocalFileTimes());
}

/** 选择文件夹后：**追加**一组（同名占位组会被恢复为真实文件） */
function onFolderChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // 立即清空，允许下次重新选择同一文件夹
  input.value = '';
  if (files.length === 0) return;

  const items = files
    .filter((f) => isRadarFile(f.name))
    .map((f) => ({ file: f, relPath: relPathOf(f) }));

  if (!addLocalFolder(items)) {
    ElMessage.warning('该文件夹内没有可识别的雷达文件（需 .bin/.m4/.bz2 且文件名含 14 位时刻）');
    return;
  }
  syncFromStore();
}

/** 删除一个父级文件夹（整组文件） */
function onRemoveGroup(groupId: number | null): void {
  if (groupId == null) return;
  removeLocalFolder(groupId);
  syncFromStore();
}

/** 递归统计目录下（含子目录）文件数 */
function countFiles(node: DirNode): number {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countFiles(d);
  node.total = n;
  return n;
}

/** 把一个组的文件构建为子树（去掉 relPath 的顶层文件夹段，避免组名重复显示） */
function buildGroupRoot(g: LocalFolderGroup): DirNode {
  const root: DirNode = { name: g.name, path: '', dirs: new Map(), files: [], total: 0 };
  for (const e of g.entries) {
    const parts = e.relPath.split('/').slice(1); // 第 1 段 = 顶层文件夹名
    const fileName = parts.pop() ?? e.file?.name ?? e.relPath;
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
    cur.files.push({ name: fileName, file: e.file, size: e.size });
  }
  countFiles(root);
  return root;
}

/** 按当前折叠状态输出可见节点（每组一个父级节点，目录在前、同类按名称排序） */
const visibleNodes = computed<FlatNode[]>(() => {
  const out: FlatNode[] = [];

  const walk = (
    node: DirNode,
    depth: number,
    nodeKey: string,
    groupId: number,
    ready: boolean
  ): void => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      const key = nodeKey + '/' + dir.name;
      out.push({
        key,
        name: dir.name,
        depth,
        isDir: true,
        childCount: dir.total,
        file: null,
        size: 0,
        groupId,
        isGroupRoot: false,
        ready
      });
      if (!collapsed.value.has(key)) walk(dir, depth + 1, key, groupId, ready);
    }
    const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of files) {
      out.push({
        key: nodeKey + '/' + f.name,
        name: f.name,
        depth,
        isDir: false,
        childCount: 0,
        file: f.file,
        size: f.size,
        groupId,
        isGroupRoot: false,
        ready
      });
    }
  };

  for (const g of groups.value) {
    const root = buildGroupRoot(g);
    const groupKey = 'g' + g.id;
    out.push({
      key: groupKey,
      name: g.name,
      depth: 0,
      isDir: true,
      childCount: root.total,
      file: null,
      size: 0,
      groupId: g.id,
      isGroupRoot: true,
      ready: g.ready
    });
    if (!collapsed.value.has(groupKey)) walk(root, 1, groupKey, g.id, g.ready);
  }
  return out;
});

/** 展开 / 折叠目录 */
function toggleDir(key: string): void {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}

/** 点击文件 → 交给激活屏渲染；记忆占位的文件提示重新选择文件夹 */
function onLoadEntry(file: File | null, ready: boolean): void {
  if (!ready || !file) {
    ElMessage.info('该文件来自上次记忆，请重新选择该文件夹后再加载');
    return;
  }
  uploadToScreen(appState.activeScreenId, file);
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

// 启动时恢复上次选择的文件夹结构（文件内容需重新选择目录后才能加载）
onMounted(() => {
  restoreLocalFolders();
  syncFromStore();
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

    <p v-if="groups.length === 0" class="folder-empty">
      尚未选择文件夹（可多次选择累加，下次打开仍会记住）
    </p>

    <!-- 目录层级树：每个顶层文件夹是一个父级节点，父级后可删除 -->
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
          <!-- 记忆占位的父级：提示需重新选择该文件夹 -->
          <span
            v-if="n.isGroupRoot && !n.ready"
            class="folder-pending"
            title="需重新选择该文件夹才能加载文件"
          >
            需重选
          </span>
          <span class="folder-item-size">{{ n.childCount }}</span>
          <!-- 顶层文件夹（父级）才显示删除；.stop 避免触发折叠 -->
          <span
            v-if="n.isGroupRoot"
            class="folder-del"
            title="删除该文件夹"
            @click.stop="onRemoveGroup(n.groupId)"
          >
            删除
          </span>
        </button>

        <button
          v-else
          class="folder-item"
          :class="{ 'folder-item--pending': !n.ready }"
          :style="{ paddingLeft: 6 + n.depth * 14 + 'px' }"
          :title="n.key"
          @click="onLoadEntry(n.file, n.ready)"
        >
          <span class="folder-item-name">{{ n.name }}</span>
          <span class="folder-item-size">{{ formatSize(n.size) }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
