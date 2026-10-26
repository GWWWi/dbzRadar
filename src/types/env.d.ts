/**
 * types/env.d.ts —— Vite 环境变量（.env / .env.[mode]）的类型声明
 *
 * 约定（改环境请动 .env，不要在业务文件里写死地址）：
 *   - 只有 `VITE_` 前缀的变量会进入前端产物，其余变量构建时不外泄；
 *   - 值是**构建时内联的字面量**，不是运行时读取 → 改 .env 必须重新
 *     `npm run dev`（重启）或 `npm run build`（覆盖站点）才生效；
 *   - 全部按可选（`?:`）声明：未知 mode（如 `--mode staging`）或漏配文件时
 *     读到 undefined，由读取处的兜底默认值接管（见 config/dataSource.ts、
 *     render/mapManager.ts），保证缺配置也能按开发默认跑起来；
 *   - 本文件是全局脚本（不能有 import/export），否则接口合并会失效。
 *
 * 基接口 ImportMetaEnv 由 tsconfig 的 `types: ["vite/client"]` 提供，
 * 这里只做字段补充；不要重复声明 `interface ImportMeta`。
 * 值清单与含义见根目录 .env.example。
 */
interface ImportMetaEnv {
  /** 雷达数据服务前缀（同源路径，或已开启 CORS 的绝对地址；末尾必须带 /） */
  readonly VITE_DATA_BASE_URL?: string;
  /** 天地图瓦片服务基地址；空串/未配置 = 回退公网 DataServer */
  readonly VITE_TILE_SERVICE_BASE?: string;
  /** 天地图 key（内网 WMTS 的 tk 与公网 DataServer 的 tk 不通用，需成对配置） */
  readonly VITE_TIANDITU_KEY?: string;
}
