/**
 * config/dataSource.ts —— 雷达数据服务地址
 *
 * 数据文件（.m4 / .bin / manifest）统一从该基地址获取。
 *
 * 默认 '/radar-data/' 是同源路径：
 *   - 开发环境由 vite.config.ts 的 proxy 转发到
 *     http://localhost:9099/data/radarData/，避免浏览器跨域
 *     （9099 静态服务未返回 CORS 头，前端直接 fetch 绝对地址会被拦截）；
 *   - 生产环境需在 nginx 配置同样的反向代理，或把这里改成
 *     一个已开启 CORS 的绝对地址（如 http://host:9099/data/radarData/）。
 *
 * ★ 末尾必须带 / ★（取数时直接拼接文件名）
 */
export const DATA_BASE_URL = '/radar-data/';
