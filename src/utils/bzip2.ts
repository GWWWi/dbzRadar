/**
 * utils/bzip2.ts —— bzip2 解压（浏览器端）
 *
 * 雷达基数据常以 `.bz2` 分发（体积约为原始文件的 1/4），浏览器没有内置解压能力，
 * 这里用纯 JS 的 seek-bzip。
 *
 * ★ 为什么不用项目里已有的 compressjs ★
 *   compressjs 在浏览器端会触发 amdefine（AMD 兼容层）加载，直接抛
 *   "define is not function"，只能用于 Node 脚本（prepare-data 解压）。
 *   seek-bzip 无该问题，但它是 Node 时代实现、运行期依赖全局 `Buffer`，
 *   浏览器需注入 buffer polyfill（见下方几行）。
 */

import { Buffer } from 'buffer';
import Bunzip from 'seek-bzip';

/**
 * 注入全局 Buffer。
 *
 * seek-bzip 内部用 `new Buffer(n)` 作可写字节数组（`.toString('hex')` / `.copy`），
 * 浏览器环境没有该全局对象，这里在调用 decode 之前补上。
 * 模块加载阶段 seek-bzip 不会立即使用 Buffer，所以静态 import 后再注入是安全的。
 */
const globalScope = globalThis as unknown as { Buffer?: typeof Buffer };
if (!globalScope.Buffer) globalScope.Buffer = Buffer;

/**
 * 判断数据是否为 bzip2 流（魔数 `BZh`，即 0x42 0x5A 0x68）。
 *
 * 用魔数而不是扩展名判断：文件改名/无扩展名时依然可靠；
 * 同时能拦截“文件名是 .bz2、内容却不是”的损坏文件。
 */
export function isBzip2Data(input: ArrayBuffer): boolean {
  if (input.byteLength < 3) return false;
  const head = new Uint8Array(input, 0, 3);
  return head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68;
}

/**
 * 解压 bzip2 数据。
 *
 * 同步执行：6~7MB 的基数据约需数百毫秒到 1 秒，取数阶段只做一次
 * （解析结果有 LRU 缓存，不会在播放/切时次时重复解压）。
 *
 * @param input 压缩数据
 * @returns 解压后的 ArrayBuffer（可直接交给解析器）
 * @throws 数据损坏/非 bzip2 流时抛错，由调用方转成“加载失败”提示
 */
export function decompressBzip2(input: ArrayBuffer): ArrayBuffer {
  const compressed = new Uint8Array(input);
  // decode 返回 Buffer（Uint8Array 子类）；按 byteOffset/byteLength 截取，
  // 避免底层 ArrayBuffer 存在偏移时带出多余字节。
  const out = Bunzip.decode(compressed) as Uint8Array;
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
