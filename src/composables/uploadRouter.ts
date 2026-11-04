/**
 * composables/uploadRouter.ts —— 跨组件文件上传路由
 *
 * 左侧「文件夹文件」区块需要把选中的文件交给「当前激活屏」解析渲染，
 * 但每屏的地图 / 图层状态都在各自的 useRadarScreen 实例里，Vue 事件无法跨组件直达。
 * 这里用模块级处理器表做路由：每屏挂载时注册自己的 onUpload，卸载时注销；
 * 侧栏按 appState.activeScreenId 找到激活屏处理器并调用。
 *
 * 处理器表用普通 Map（不进 reactive），避免把函数放进响应式代理带来的额外开销。
 */

type UploadHandler = (file: File) => void;

/** 各屏上传处理器：key = 屏稳定 id */
const handlers = new Map<number, UploadHandler>();

/** 注册某屏的上传处理器（useRadarScreen 挂载时调用） */
export function registerUploadHandler(screenId: number, handler: UploadHandler): void {
  handlers.set(screenId, handler);
}

/** 注销某屏的上传处理器（useRadarScreen 卸载时调用） */
export function unregisterUploadHandler(screenId: number): void {
  handlers.delete(screenId);
}

/**
 * 把文件交给指定屏解析渲染。
 * 该屏未就绪（地图未创建）时静默忽略，与 onUpload 自身 `if (!map) return` 的行为一致。
 */
export function uploadToScreen(screenId: number, file: File): void {
  handlers.get(screenId)?.(file);
}
