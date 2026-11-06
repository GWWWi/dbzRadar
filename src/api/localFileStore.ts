/**
 * api/localFileStore.ts —— 目录句柄持久化（IndexedDB）
 *
 * 仅用于 File System Access API：把 showDirectoryPicker 返回的
 * FileSystemDirectoryHandle 存入 IndexedDB，下次打开浏览器可重新枚举目录内容，
 * 从而做到“不需要重新选择文件夹”（前提是权限仍为 granted，或用户点一次“恢复”授权）。
 *
 * 注意：FileSystemDirectoryHandle 属于可结构化克隆对象，才能放进 IndexedDB；
 * 普通 File 对象无法这样持久化。非安全上下文不会产生句柄，本模块自然不被使用。
 */

const DB_NAME = 'radar-local-files';
const STORE = 'dir-handles';
const DB_VERSION = 1;

/** 打开（或创建）句柄数据库；环境不支持时 reject，由调用方捕获降级 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 保存全部句柄（以组 id 为键；整体覆盖，删除的组自然被移除） */
export async function saveDirHandles(
  entries: { id: number; handle: FileSystemDirectoryHandle }[]
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      for (const e of entries) store.put(e.handle, e.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** 读取全部句柄；环境不支持 / 读取失败时返回空数组 */
export async function loadDirHandles(): Promise<
  { id: number; handle: FileSystemDirectoryHandle }[]
> {
  const db = await openDb();
  try {
    return await new Promise<{ id: number; handle: FileSystemDirectoryHandle }[]>(
      (resolve, reject) => {
        const out: { id: number; handle: FileSystemDirectoryHandle }[] = [];
        const tx = db.transaction(STORE, 'readonly');
        const cursorReq = tx.objectStore(STORE).openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            out.push({ id: Number(cursor.key), handle: cursor.value as FileSystemDirectoryHandle });
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
      }
    );
  } finally {
    db.close();
  }
}
