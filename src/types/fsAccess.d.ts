/**
 * types/fsAccess.d.ts —— File System Access API 的最小类型补充
 *
 * TypeScript 标准 DOM lib 未声明 showDirectoryPicker、目录异步枚举与权限查询方法。
 * 这些 API 仅在 Chromium 系浏览器 + 安全上下文（https / localhost）下可用；
 * 非安全上下文（如局域网 http）时 window.showDirectoryPicker 为 undefined，
 * 调用方必须降级到 <input webkitdirectory>。
 */

interface FileSystemDirectoryHandle {
  /** 异步枚举目录项（Chromium 实现；标准 DOM lib 未声明） */
  values(): AsyncIterableIterator<FileSystemHandle>;
  /** 查询当前权限（'granted' 表示可直接读取，无需再次授权） */
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  /** 请求权限（必须在用户手势中调用） */
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface Window {
  /** 打开系统目录选择器（Chromium，安全上下文） */
  showDirectoryPicker?(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }): Promise<FileSystemDirectoryHandle>;
}
