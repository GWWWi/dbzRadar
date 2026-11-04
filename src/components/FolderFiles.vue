<!--
  FolderFiles.vue —— 左侧侧栏「文件夹文件」区块

  功能：
    - 「选择文件夹」：调起系统文件夹选择器（input[webkitdirectory]），
      递归收集所选目录内的雷达数据文件（.bin / .m4 / .bz2，与屏头上传 accept 一致）；
    - 列表展示文件名 / 相对路径 / 大小；
    - 点击某项 → 经 uploadRouter 交给当前激活屏解析渲染（等同「上传」）。
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { appState, setLocalFileTimes } from '../store/appStore';
import { uploadToScreen } from '../composables/uploadRouter';
import { setLocalFolderFiles } from '../api/localFiles';

/** 文件夹中的一个可加载文件；File 内容延迟读取，不占内存 */
interface FolderEntry {
  file: File;
  /** 相对所选文件夹的路径（含子目录），用于展示与排序 */
  relPath: string;
}

const folderName = ref('');
const entries = ref<FolderEntry[]>([]);
const inputRef = ref<HTMLInputElement | null>(null);

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

/** 选择文件夹后：过滤 + 排序出可加载文件列表 */
function onFolderChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // 立即清空，允许下次重新选择同一文件夹
  input.value = '';

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

/** 点击文件 → 交给激活屏渲染 */
function onLoadEntry(entry: FolderEntry): void {
  uploadToScreen(appState.activeScreenId, entry.file);
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

    <ul v-if="entries.length" class="folder-list">
      <li v-for="e in entries" :key="e.relPath">
        <button class="folder-item" :title="e.relPath" @click="onLoadEntry(e)">
          <span class="folder-item-name">{{ e.file.name }}</span>
          <span class="folder-item-size">{{ formatSize(e.file.size) }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
