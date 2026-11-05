<!--
  FolderFiles.vue —— 左侧侧栏「文件夹文件」区块

  功能：
    - 「选择文件夹」：
        · 优先 File System Access API（showDirectoryPicker）——可保存目录句柄，
          下次打开浏览器**自动恢复文件**（无需重选）；
        · 不支持时（http 局域网 / 非 Chromium）降级为 input[webkitdirectory]；
    - 多次选择**累加**：每个顶层文件夹是一个父级节点，互不覆盖；
    - 跨会话记忆：下次打开仍能看到上次的文件夹结构；
      有句柄且权限未授权时父级显示「恢复」，点一次即可，无需重新选目录；
    - 父级节点后的「删除」可整组移除；
    - 目录层级按相对路径还原，目录可展开/折叠；
    - 点击文件 → 经 uploadRouter 交给当前激活屏解析渲染（等同「上传」）。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { appState, setLocalFileTimes } from '../store/appStore';
import { uploadToScreen } from '../composables/uploadRouter';
import {
  addLocalFolder,
  collectDirFiles,
  getLocalFileTimes,
  getLocalGroups,
  isRadarFileName,
  removeLocalFolder,
  restoreGroupFromHandle,
  restoreLocalFolders
} from '../api/localFiles';
import type { LocalFolderGroup } from '../api/localFiles';
// 提示文案统一走 constants/messages（同一句“没有可识别文件”此前在两个入口各写一份）
import { FOLDER_MSG } from '../constants/messages';

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
  /** 所属组是否含真实文件（false = 记忆占位） */
  ready: boolean;
  /** 是否有目录句柄（有则可点「恢复」自动读取，无需重新选择） */
  hasHandle: boolean;
}

const groups = ref<LocalFolderGroup[]>([]);
const inputRef = ref<HTMLInputElement | null>(null);
/** 已折叠的目录 key 集合（默认空 = 全部展开） */
const collapsed = ref<Set<string>>(new Set());
/**
 * 是否支持目录授权（showDirectoryPicker）。
 * true：选择文件夹时可保存句柄，下次自动恢复；false：http 局域网等非安全上下文，只能重新选择。
 */
const canAutoRestore = typeof window.showDirectoryPicker === 'function';

/**
 * 打开文件夹选择器。
 * 优先 File System Access API（能保存句柄、下次自动恢复）；失败/不支持时降级 input。
 */
async function onPickFolder(): Promise<void> {
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      const handle = await window.showDirectoryPicker({ id: 'radar-folder', mode: 'read' });
      const items = await collectDirFiles(handle);
      if (!addLocalFolder(items, handle)) {
        ElMessage.warning(FOLDER_MSG.noRadarFile);
        return;
      }
      syncFromStore();
      return;
    } catch (e) {
      // 用户取消选择：静默返回
      if (e instanceof DOMException && e.name === 'AbortError') return;
      console.warn('[FolderFiles] showDirectoryPicker 失败，降级为 input 选择：', e);
    }
  }
  // 降级路径：webkitdirectory（无法保存句柄，下次仍需重新选择或点「恢复」）
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
    .filter((f) => isRadarFileName(f.name))
    .map((f) => ({ file: f, relPath: relPathOf(f) }));

  if (!addLocalFolder(items)) {
    ElMessage.warning(FOLDER_MSG.noRadarFile);
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

/** 对占位组请求目录权限并自动读取（有句柄时可用，点一次即可） */
async function onRestoreGroup(groupId: number | null): Promise<void> {
  if (groupId == null) return;
  if (await restoreGroupFromHandle(groupId)) {
    syncFromStore();
    ElMessage.success(FOLDER_MSG.restored);
  } else {
    ElMessage.warning(FOLDER_MSG.restoreFailed);
  }
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
    ready: boolean,
    hasHandle: boolean
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
        ready,
        hasHandle
      });
      if (!collapsed.value.has(key)) walk(dir, depth + 1, key, groupId, ready, hasHandle);
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
        ready,
        hasHandle
      });
    }
  };

  for (const g of groups.value) {
    const root = buildGroupRoot(g);
    const groupKey = 'g' + g.id;
    const hasHandle = !!g.handle;
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
      ready: g.ready,
      hasHandle
    });
    if (!collapsed.value.has(groupKey)) walk(root, 1, groupKey, g.id, g.ready, hasHandle);
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

/** 点击文件 → 交给激活屏渲染；记忆占位的文件提示重新选择或点「恢复」 */
function onLoadEntry(file: File | null, ready: boolean): void {
  if (!ready || !file) {
    ElMessage.info(FOLDER_MSG.pendingEntry);
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

// 启动时恢复上次选择的文件夹（有句柄且已授权则直接读出文件，无需重选）
onMounted(async () => {
  await restoreLocalFolders();
  syncFromStore();
  console.info(
    `[FolderFiles] 目录自动恢复${canAutoRestore ? '已启用' : '不可用（需 https 或 localhost）'}`
  );
});
</script>

<template>
  <div class="folder-panel">
    <div class="panel-title">
      文件夹文件
      <span class="panel-sub">作用于第 {{ activeIndex }} 屏</span>
    </div>

    <button class="btn folder-pick" @click="onPickFolder">选择文件夹</button>

    <!-- 降级路径的隐藏输入：webkitdirectory 递归收集所选目录内全部文件 -->
    <input
      ref="inputRef"
      type="file"
      webkitdirectory
      multiple
      hidden
      @change="onFolderChange"
    />

    <!-- 环境提示：非 https/localhost 时无法保存目录句柄，只能重新选择 -->
    <p v-if="!canAutoRestore" class="folder-hint">
      当前环境不支持目录授权记忆（需 https 或 localhost），下次打开需重新选择文件夹。
    </p>

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
          <!-- 占位父级：有句柄可点「恢复」自动读取；无句柄只能重新选择 -->
          <span
            v-if="n.isGroupRoot && !n.ready && n.hasHandle"
            class="folder-restore"
            title="点击授权并自动读取该文件夹（无需重新选择）"
            @click.stop="onRestoreGroup(n.groupId)"
          >
            恢复
          </span>
          <span
            v-else-if="n.isGroupRoot && !n.ready"
            class="folder-pending"
            title="点击重新选择该文件夹（该组没有目录授权，无法自动恢复）"
            @click.stop="onPickFolder"
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
