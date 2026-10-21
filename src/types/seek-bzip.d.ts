/**
 * seek-bzip 无官方类型声明，这里只声明项目用到的 decode。
 * 实际返回值为 Buffer（Uint8Array 子类），声明为 Uint8Array 足够使用。
 */
declare module 'seek-bzip' {
  const Bunzip: {
    /**
     * 解压 bzip2 数据。
     * @param input      压缩数据（Buffer / Uint8Array）
     * @param multistream 是否解压“多流拼接”文件（默认 false）
     */
    decode(input: Uint8Array, multistream?: boolean): Uint8Array;
  };
  export default Bunzip;
}
