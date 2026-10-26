# 雷达平台部署运行手册（dbzRadar）

> 版本 v1.0｜编制日期 2026-10-26｜实测环境：Windows + nginx 1.25.1（`D:\nginx-1.25.1`）
> 关联文档：`AGENTS.md`（§2 命令、§6 硬性约束 18/19、§8 配方 F）、`CLAUDE.md`（变更日志）、`docs/PRODUCT_GUIDE.md`
> 本手册所有数值/状态均为**本机实测**，不是推测；标 ★待定★ 的条目需现场定案后回填。

---

## 0. 一分钟看懂当前状态

| 项 | 状态 | 依据（实测） |
|---|---|---|
| 数据下发链路 | ✅ 通 | `GET /data/radarData/Z_RADR_I_Z9517_20261018000131_…bin.bz2` → `200 application/octet-stream 6964378B` |
| wasm MIME | ✅ 通 | `/libs/wasm/qe_lib_bg.wasm` → `200 application/wasm` |
| 站点上跑的前端包 | ⚠ **是旧包** | 站点 `dist/assets/index-BoTaCfxd.js` ≠ 仓库最新 `dist/assets/index-_v30F5IK.js`；旧包内仍是**公网天地图 tk**、无 `10.1.65.144` |
| 清单实际来源 | ⚠ 走 autoindex 扫描 | `/data/radarData/manifest.json` → **404**（清单文件在 `E:\ngi\met\`，不在 `radarData\`）→ 前端降级扫描 `/data/radarData/` 目录列表（200，1071B）成功 |
| `E:\ngi\met\manifest.json` | ⚠ **当前没被读取** | 只有前两条都失败才会用到它 |
| 内网天地图 WMTS | ❌ 本机不可达 | `curl http://10.1.65.144:81/vec_w/wmts?...` 四次全部 `000`（不在该网段），**瓦片能否出图尚未验证** |
| 应用配置 config.json | ✅ 缺席（正确） | `/data/config.json` → 404 → 清单模式。**这批数据必须保持清单模式**，原因见 §3.4 |

**发布前必须做的两件事**：① 把仓库新构建的 `dist` 覆盖到 `E:\ngi\dbzRadar\dist`（§5）；② 决定 manifest 放哪（§7）。

---

## 1. 部署运行需要的东西（总清单）

### 1.1 软件

| 软件 | 用途 | 要求 | 校验 |
|---|---|---|---|
| Node.js | **仅构建机**需要 | ≥ 18 | `node -v`（本机 20.19.2） |
| nginx | 站点 + 数据下发 | 1.25.1 及以上（1.21+ 自带 wasm MIME） | `.\nginx.exe -v` |
| 浏览器 | 运行端 | 支持 WebGL2（Chrome/Edge 现代版本）；HTTP 即可，无需 HTTPS | — |
| 9099 静态数据服务 | **仅 dev**（Vite 代理后端） | dev 机器本机 | `Get-NetTCPConnection -LocalPort 9099` |

### 1.2 目录（四个，缺一不可）

| 目录 | 角色 | 说明 |
|---|---|---|
| `E:\test\gitHub\dbzRadar` | 源码 + 构建产物 | `npm run build` → 其下 `dist/` |
| `E:\ngi\dbzRadar\dist` | **站点根**（nginx `root`） | 必须含 `index.html`、`assets/`、`libs/`、`data/`；**必须部署在站点根路径**，`src/main.ts` 里 `/libs/wasm`、`/libs/workers` 是写死的绝对路径 |
| `E:\ngi\met\radarData` | **雷达数据目录**（平铺） | nginx `alias` 的目标；前端取数基址就是它 |
| `E:\ngi\met` | 数据上级目录 | `location /data { alias E:/ngi/met; }`，故 `/data/xxx` ↔ `E:\ngi\met\xxx` |

### 1.3 配置文件（5 个）

| 文件 | 位置 | 何时需要 |
|---|---|---|
| `.env.production` | 仓库根（构建时读取） | 生产前缀与内网瓦片地址；**改动后必须重新 build** |
| `.env.development` | 仓库根 | 本机开发（`/radar-data/` + 公网瓦片） |
| `nginx.conf` 第 375–411 行 | `D:\nginx-1.25.1\conf\` | 站点与数据 location |
| `manifest.json` | `E:\ngi\met\radarData\`（**建议**，当前在上级） | 想让清单优先生效时 |
| `config.json` | **故意不放** | 见 §3.4；放错会让全屏「该时次无数据」 |
| `products.json` | 可选（`/data/products.json`） | 有则用服务器产品目录，无则回退内置静态目录 |

### 1.4 端口

| 端口 | 用途 | 谁访问 |
|---|---|---|
| 9094 | 生产站点（页面 + 数据同源） | 所有用户 |
| 10.1.65.144:81 | 内网天地图 WMTS | **每台客户端浏览器直连**（不是 nginx 代理） |
| 5179 | dev 服务器 | 仅开发机 |
| 9099 | dev 数据后端 | 仅开发机本机，被 Vite 代理 |

---

## 2. 环境配置（`.env`）

三个变量，值由 `mode` 决定；读取处都有兜底默认值，**缺配置也能按 dev 默认跑起来**。

| 变量 | dev（`.env.development`） | prod（`.env.production`） | 读取位置 | 兜底 |
|---|---|---|---|---|
| `VITE_DATA_BASE_URL` | `/radar-data/` | `/data/radarData/` | `src/config/dataSource.ts` → `DATA_BASE_URL` | `/radar-data/` |
| `VITE_TILE_SERVICE_BASE` | 空（=公网 DataServer） | `http://10.1.65.144:81` | `src/render/mapManager.ts` → `TILE_SERVICE_BASE` | `''` |
| `VITE_TIANDITU_KEY` | `06e4468a…`（公网） | `449b5f7b…`（内网） | 同上 → `TIANDITU_KEY` | `''` |

三条铁律：

1. **只有 `VITE_` 前缀会进产物，且是构建时内联的字面量**：改 `.env` 后 dev 要重启、生产要**重新 build 并覆盖站点**。只换服务器上的 `dist` 而不重建 = 旧值；只改 nginx 前缀而不核对 `VITE_DATA_BASE_URL` = 全量错环。
2. `VITE_DATA_BASE_URL` **必须与 nginx 的数据 location 前缀逐字一致、末尾带 `/`**（`dataSource.ts` 已做补尾斜杠兜底）。对不上时请求会落到 SPA 的 `try_files … /index.html` 回落，返回 **200 的 HTML 而不是 404**，前端把 HTML 当二进制解 → 合成兜底 → 屏头显示「**示意数据**」假回波（错得静默，最难发现的一类）。
3. `VITE_TILE_SERVICE_BASE` 与 `VITE_TIANDITU_KEY` **必须成对**切换（内网 tk 打公网服务、公网 tk 打内网服务都拿不到瓦片）。

现场专有值（内网 IP、现场 tk）不想入仓时，写 `.env.production.local`：优先级高于 `.env.production`，且已被 `.gitignore` 的 `*.local` 忽略。

---

## 3. 数据侧要求

### 3.1 目录与命名

- 数据**平铺**在一个目录（前端目录扫描不递归子目录，nginx `alias` 也只映射这一层）；
- 文件名必须含连续 **14 位数字**时刻 `yyyyMMddHHmmss`，**北京时间**；
- 剥掉 `.bz2` 后必须是 `.m4` / `.bin`（含 `RADAMOSAIC` 判拼图）之一，其他扩展名不收；
- `.bin.bz2` **服务端不用解压**：前端 `utils/bzip2.ts`（seek-bzip）在浏览器端解压，再按二进制魔数（`RSTM` / `SWAN` / `diamond 4`）复核格式。

当前实例：`Z_RADR_I_Z9517_20261018000131_O_DOR_SAD_CAP_FMT.bin.bz2` × 6 个（Z9517 单站体扫，间隔 5′34″）。

### 3.2 清单（`manifest.json`）字段

`file` / `binFile`（纯文件名，前端自动拼 `DATA_BASE_URL`）/ `time`（`yyyy-MM-ddTHH:mm:ss`）/ `stationId` / `stationName` / `hasData` / `format`(`rstm|mosaic|m4`) / `compressed`（`.bz2` 必须 `true`）。
参考 `E:\ngi\met\manifest.json`（6 条，字段合规）。

### 3.3 清单放哪才生效（实测）

| 候选位置 | 对应 URL | 前端会不会用 |
|---|---|---|
| `E:\ngi\met\radarData\manifest.json` | `/data/radarData/manifest.json` | ✅ **优先使用**（首选通道）——目前此文件不存在 |
| `E:\ngi\met\manifest.json`（现状） | `/data/manifest.json` | ⚠ 只有第 1 条与目录扫描都失败后才会用到 → **当前是被忽略的** |
| `dist\data\manifest.json` | `/data/manifest.json` | ❌ 被 nginx `alias` 遮蔽，访问不到 |

**要做的事**：把 `E:\ngi\met\manifest.json` 移入 `E:\ngi\met\radarData\`（或让生成脚本直接写那里），否则就一直靠 autoindex 扫描出清单。

### 3.4 ★ 这批数据不要放 `config.json`

现有文件时刻是 `00:01:31 / 00:07:07 / 00:12:43 …`（体扫用时 5′34″，**秒位不齐**）。一旦存在 `config.json`，时间轴改由 `buildTimelineTimes` 按「整分钟 + intervalMinutes」生成，而清单匹配是**精确字符串比较**（`RadarScreen.refresh`：`files.find(f => f.time === sc.time)`）→ 每个时次都对不上，整屏「该时次无数据」。

只有当数据源能对齐整分钟栅格（如 SWAN 拼图 `…_20261018065400.bin`）时，才启用模板模式（`fileUrlTemplate` 含 `/` 时**原样当地址用、不拼 DATA_BASE_URL**，指向数据服务要写全前缀）。

---

## 4. nginx 配置（现网 375–411 行的逐段结论）

现配置**可用**（§0 的实测就是拿它跑的），三个已知小毛病：

| # | 位置 | 现象 | 处理建议 |
|---|---|---|---|
| 1 | L392 `location /data` | 无尾斜杠 → 前缀匹配会顺带吃掉 `/database/...`、`/dataX/...` | 改成 `location /data/ { alias E:/ngi/met/; }`（两处斜杠成对） |
| 2 | L399/L401 嵌套 location | 实测 `alias` 在 1.25.1 **能**继承、缓存头**能**生效（本手册早前版本判断偏保守，已更正）；但数据文件出现**两个** `Cache-Control`（`expires 7d` 与 `add_header` 各发一次） | 二选一：只留 `expires 7d;`，删掉 `add_header Cache-Control "public";` |
| 3 | `location /data` 与站点 `root` 都用 `/data` | `dist/data/`（示例 config/products/manifest）被 alias 遮蔽，站点上访问不到 | 若要保留站点示例文件，给数据换独立前缀（如 `/radar-data/`）并同步改 `.env.production` 后重新 build |

`location /radar-data/` 在当前配置里**不存在**，所以生产前缀必须是 `/data/radarData/`（`.env.production` 已这么写）。若日后把 nginx 改成 `/radar-data/`，记得同步改 `.env.production` 并重新构建。

---

## 5. 发布流程（每次前端改动）

```powershell
cd E:\test\gitHub\dbzRadar

# 1) 构建（含 vue-tsc 类型检查）
npm run build

# 2) ★ 核对产物里的环境值（必做，变量是构建时内联的）
Select-String -Path dist\assets\index-*.js -Pattern "10\.1\.65\.144" -SimpleMatch -List
Select-String -Path dist\assets\index-*.js -Pattern "/data/radarData/" -SimpleMatch -List
#    两条都必须命中；没命中 = .env.production 没被读到（文件名/mode 不对）

# 3) 备份现站点 → 覆盖
Copy-Item E:\ngi\dbzRadar\dist E:\ngi\dbzRadar\dist_bak_$(Get-Date -Format yyyyMMddHHmm) -Recurse
Remove-Item E:\ngi\dbzRadar\dist\* -Recurse -Force
Copy-Item .\dist\* E:\ngi\dbzRadar\dist\ -Recurse -Force

# 4) 只在改了 nginx 配置时执行
cd D:\nginx-1.25.1
.\nginx.exe -t
.\nginx.exe -s reload
```

只改数据 → 不需要 build 也不需要 reload；只改 nginx → 不需要 build；改 `.env` → **必须 build**。

回滚：删掉新 `dist`，把 `dist_bak_*` 改名回 `dist`（未改 nginx 时无需 reload）。

---

## 6. 验收清单（带实测预期值）

```powershell
$u = "http://127.0.0.1:9094"
foreach ($p in "/", "/data/radarData/", "/data/radarData/manifest.json",
    "/data/radarData/Z_RADR_I_Z9517_20261018000131_O_DOR_SAD_CAP_FMT.bin.bz2",
    "/libs/wasm/qe_lib_bg.wasm", "/data/config.json") {
  $r = curl.exe -s -o NUL -w "%{http_code} %{content_type} %{size_download}B" --path-as-is "$u$p"
  "{0,-72} {1}" -f $p, $r
}
```

| 请求 | 预期（本机实测值） | 不对时说明什么 |
|---|---|---|
| `/` | `200 text/html 493B` | 404 → `root` 路径不对 |
| `/data/radarData/` | `200 text/html; charset=utf-8 1071B`（autoindex 列表） | 403/404 → `alias` 尾斜杠或目录权限 |
| `/data/radarData/manifest.json` | 现在 `404`（清单未就位）；放好后应为 `200 application/json` + `Cache-Control: no-store` | 404 仍可工作（降级扫描） |
| 数据文件 | `200 application/octet-stream 6964378B` | **`text/html` → 前缀与 `DATA_BASE_URL` 不一致（§2 铁律 2）** |
| `/libs/wasm/qe_lib_bg.wasm` | `200 application/wasm` | 404 → `dist/libs` 没发布 |
| `/data/config.json` | `404`（正确，走清单模式） | 200 → 检查是否误放了 config.json |

浏览器侧 6 项（F12）：

1. Console 无 `[radarApi] 数据服务未提供 manifest.json` 之外的红字（该条 warn 是**预期**的，因为清单文件还没就位）；
2. Network 中数据请求前缀为 `/data/radarData/`，**Content-Type 必须是 `application/octet-stream`**，出现 `text/html` 立即回 §2；
3. 选一个有数据的时次 → 出真实回波，屏头**不显示「示意数据」**（显示即代表走了合成兜底，是假回波）；
4. 选一个无数据时次 → 屏头显示「**该时次无数据**」而不是「加载失败」；
5. 点「行政」底图 → 有瓦片；若整片空白，先确认该客户端能访问 `http://10.1.65.144:81`（浏览器直接打开一张瓦片 URL），再确认层级（内网节点常只到 10~12 级，需把 `mapManager.ts` 的 `maxNativeZoom` 改成实际层级）；
6. 4/6 屏 + 播放：同一时次文件只下载一次（Network 无重复 URL）——验证在途合并与 LRU 生效。

默认底图是「**国界**」（本地 GeoJSON，不依赖任何瓦片服务），所以内网瓦片服务不通也不影响主流程出图。

---

## 7. 获取最新数据 —— ★ 形式待定 ★

### 7.1 代码既有行为（改造前必须知道）

1. 清单/配置**只在页面启动时拉一次**（`App.vue` 的 `onMounted`），无轮询、无刷新按钮 → 新文件要生效 = 清单/目录已反映新文件 **+ 用户刷新页面**；
2. 时间轴末端在生成时冻结（`buildTimelineTimes` 锚点取当时 `Date.now()`）；清单模式下时间轴 = 清单时刻集合，所以「新时次出现」完全取决于清单是否更新；
3. `configApi.fetchLatestTime()` 是**假数据**（返回当前时间取整分钟），只用于启动时定位视图；
4. LRU 缓存键 = `文件名|产品` → **同名文件被覆盖**时本会话仍返回旧网格（含秒命名可规避）；
5. 时间轴时次上限 3000，清单无限累积会让时间轴过密、刻度轴变卡。

### 7.2 候选方案

| 方案 | 服务端要做 | 实时性 | 说明 |
|---|---|---|---|
| A. autoindex 扫描 | **什么都不做**（当前就是它在工作） | 刷新即最新 | 零维护；无法裁剪时间窗口、`stationName` 只能取站号；文件很多时列表 HTML 很大 |
| B. manifest + 计划任务 | 定时把清单写进 `radarData\` | 刷新即最新 | 推荐默认；可控、可按天裁剪 |
| C. manifest + 常驻监听 | 脚本 `--watch=30` 常驻 | 秒级进清单 | 正式运行首选 |
| D. config 模板模式 | 数据严格对齐整分钟 | 最好 | **当前数据不满足**（§3.4），二期数据源规整后再用 |
| E. 接后端接口 | 提供最新时次/清单接口 | 最好 | 替换 `fetchLatestTime` / `fetchRadarFileList`，返回值经 `snapNearestTime` 吸附，任意精度都安全 |

### 7.3 定案前先做这两步（临时默认）

1. 把清单放进 `E:\ngi\met\radarData\manifest.json`（让首选通道生效，摆脱对 autoindex 的依赖）；
2. 挂计划任务定期重生成（并只保留最近 N 天，控制时间轴密度）：

```powershell
schtasks /Create /TN dbzRadarManifest /SC MINUTE /MO 5 `
  /TR "node E:\test\gitHub\dbzRadar\scripts\gen-manifest.cjs --dir=E:/ngi/met/radarData --days=10"
```

> `scripts/gen-manifest.cjs` **尚未创建**（上一轮只给了内容）。要我落文件就说一声。

### 7.4 待决表（定案后回填）

| 待决项 | 选项 | 影响 | 负责人 | 日期 |
|---|---|---|---|---|
| 清单生成方式 | A / B / C | 新文件可见延迟 | 待定 | 待定 |
| 清单存放位置 | `radarData\`（推荐）/ 上级 `met\` | 首选通道是否生效 | 待定 | 待定 |
| 是否给前端加清单轮询 + 刷新按钮 | 是 / 否 | 是否必须刷新页面 | 待定 | 待定 |
| 是否接真实「最新时次」接口 | 是 / 否 | 替换假数据 `fetchLatestTime` | 待定 | 待定 |
| 数据保留窗口 | 10 / 30 天 | 时间轴密度、磁盘（单站 6.8MB/时次） | 待定 | 待定 |
| 同名覆盖更新是否存在 | 是 / 否 | 是则禁用数据长缓存（改 `no-cache`） | 待定 | 待定 |

---

## 8. 故障排查表

| 现象 | 根因 | 处理 |
|---|---|---|
| 地图空白、控制台 wasm 404 | `dist/libs` 未发布，或站点放到了子路径 | 补齐 `libs/`；站点必须部署在根 |
| 屏头显示「**示意数据**」/整幅假团块 | 数据请求被 SPA 回落成 200 HTML（前缀与 `VITE_DATA_BASE_URL` 不一致）；或解压后魔数不符 | 按 §6 数据文件那条 curl 看 Content-Type；核对 `.env.production` 后重新 build |
| 一直「该时次无数据」 | ① 前缀错致全 404；② 误放了 `config.json`（秒位不齐）；③ 清单 `binFile` 写成不含 `/` 的相对路径之外的形式 | §6 curl；删 `config.json`；`binFile` 用纯文件名 |
| 「行政」底图整片空白 | 客户端不可达内网瓦片 IP；或请求层级超过内网节点支持 | 浏览器直接打开瓦片 URL；改 `maxNativeZoom`；或走 nginx 同源反代 `/tianditu/` 并把 `VITE_TILE_SERVICE_BASE=/tianditu` 重新 build |
| 缩放/拖动后色斑才更新 | 违反 `AGENTS.md` §6-16（局部更新后未 `forceRedraw`） | 检查渲染层改动 |
| 新文件落盘看不到 | 清单未重生成；清单被中间层缓存 | 确认计划任务在跑；`.json` 必须 `no-store`；CDN/`proxy_cache` TTL 置 0 |
| 同名覆盖后画面不变 | 前端 LRU 命中旧网格 | 刷新页面；或保持含秒命名 |
| 时间轴过密卡顿 | 清单无限累积 | 生成脚本按 `--days` 裁剪（上限 3000 时次） |
| 403 | 目录/文件权限；`alias` 指向了不可读路径 | 检查 nginx 运行账户读权限 |

---

## 9. 附录：Linux 服务器对照（当前为 Windows 实测）

| Windows | Linux |
|---|---|
| `root E:/ngi/dbzRadar/dist` | `root /opt/app/dbzRadar/dist;` |
| `alias E:/ngi/met;` | `alias /data/met/;`（大小写敏感；尾斜杠与 location 成对） |
| `D:\nginx-1.25.1\conf\nginx.conf` | `/etc/nginx/nginx.conf` + `/etc/nginx/conf.d/dbzradar.conf` |
| `schtasks` 生成清单 | `/etc/cron.d/dbzradar` 或 systemd unit，**`node` 必须写绝对路径** |
| — | nginx 账户需对**每一级父目录**有 `x`；SELinux 非标准路径要打标：`semanage fcontext -a -t httpd_sys_content_t "/data/met(/.*)?"` + `restorecon -Rv` |
| — | 中文文件名/CIFS 挂载必须 `iocharset=utf8`，否则 autoindex 的 href 乱码、清单静默为空 |
| 前端构建 | 同一份代码，`.env.production` 值改成新机器的前缀/瓦片地址即可，**不需要动 src** |

403 排查顺序：`namei -l <路径>` → 落盘 umask（root+600 时 nginx 读不到）→ `getenforce`/`ausearch -m avc` → `ss -lntp | grep 9094`。

---

## 10. 运维与安全

- **日志**：`D:\nginx-1.25.1\logs\access.log`；关注数据请求的状态码分布（大量 404 = 命名或时间轴对不齐）。
- **容量**：单站体扫 ≈ 6.8MB/时次（`.bz2`）；10 天单站 ≈ 2600 时次 × 6.8MB ≈ **18GB**，30 天约 53GB。解压后 RSTM 约 30–40MB，由浏览器解压，服务端只出压缩体。
- **带宽**：每标签页每时次首次访问才下载（前端 LRU 12 条网格 ≈80MB + 3 条体数据 ≈54MB）。
- **安全**：`autoindex on` 会公开全部文件名与大小，确认无越权风险；数据目录建议只读挂载；`.env` 里的地址与 tk 会构建进前端产物，**本质是公开值**，不要当作机密凭据使用。

---

## 11. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-26 | v1.0 | 首版。基于 `.env` 化 + 内网 WMTS 改造后的实测状态编写；纠正「嵌套 location 不继承 alias」的早期判断（1.25.1 实测可用），补入双 `Cache-Control`、manifest 位置、站点旧包三项现场问题 |
