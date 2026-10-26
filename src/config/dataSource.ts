/**
 * config/dataSource.ts —— 雷达数据服务地址
 *
 * 数据文件（.m4 / .bin / manifest）统一从该基地址获取。
 *
 * 地址由环境变量 `VITE_DATA_BASE_URL` 提供（.env.development / .env.production），
 * 缺省兜底 '/radar-data/'，类型见 src/types/env.d.ts。
 * ★ 构建时内联：改 .env 必须重新 dev（重启）/ build（覆盖站点）★
 *
 * 两个环境的差别：
 *   - 开发：'/radar-data/' —— 由 vite.config.ts 的 proxy 转发到
 *     http://localhost:9099/data/radarData/，避免浏览器跨域
 *     （9099 静态服务未返回 CORS 头，前端直接 fetch 绝对地址会被拦截）；
 *   - 生产：与 nginx 的数据 location 前缀**逐字一致**（现网 '/data/radarData/'），
 *     也可填一个已开启 CORS 的绝对地址（如 http://host:9099/data/radarData/）。
 *   前缀对不上时请求会落到 SPA 的 try_files 回落（返回 200 的 index.html），
 *   表现为屏头“示意数据”假回波而不是“该时次无数据”。
 *
 * ★ 末尾必须带 / ★（取数时直接拼接文件名）
 */
const RAW_DATA_BASE_URL = import.meta.env.VITE_DATA_BASE_URL || '/radar-data/';

/**
 * 兜底补尾斜杠：漏写一个 / 会把地址拼成 `/data/radarDataZ_RADR_….bin.bz2`，
 * 这种错不会报错、只会全量 404（拼错的路径被 SPA 回落接走），排查成本极高。
 */
export const DATA_BASE_URL: string = RAW_DATA_BASE_URL.endsWith('/')
  ? RAW_DATA_BASE_URL
  : RAW_DATA_BASE_URL + '/';
