/**
 * render/baseMap.ts —— 底图管理（天地图行政 / 国界矢量）
 *
 * 职责：
 *   - admin  天地图行政底图（vec_w 矢量底图 + cva_w 中文注记）；
 *   - border 国界/省界矢量底图：陆地 #efefdb、海洋 #97b6e1、界线 #606266；
 *   - 每张地图的底图图层登记与切换 token（异步加载回来时丢弃过期结果）。
 *
 * 多屏联动的 move 同步在 mapLink.ts；本文件不 import mapLink，避免循环依赖。
 */
import { LMap } from '@quickearth/leaflet';
import * as L from 'leaflet';
import type { BaseMapMode } from '../types';
import { fetchWithTimeout } from '../utils/http';
// 边界数据用 ?url 引入：不内联进主包，首次切换到国界底图时才按需加载
import worldBorderUrl from '../mapBorder/worldGJ.json?url';
import chinaBorderUrl from '../mapBorder/chinaGJ.json?url';
import provinceBorderUrl from '../mapBorder/chinaSJ.json?url';

/**
 * 天地图瓦片服务基地址（环境变量 `VITE_TILE_SERVICE_BASE`，
 * .env.development / .env.production，★ 构建时内联，改 .env 要重新构建 ★）。
 *
 * 内网节点按 WMTS（KVP 编码）寻址，切片路径形如 `<base>/vec_w/wmts?...`；
 * 空串/未配置 → 回退公网 DataServer（`https://t{s}.tianditu.gov.cn`，需外网出口）。
 *
 * ★ 瓦片由浏览器直接请求，不是服务端代理 ★
 *   所以 base 必须对**每台客户端**可达。客户端不可达时改成同源反代路径
 *   （与本项目的数据前缀同一思路），nginx 示例：
 *     location /tianditu/ {
 *       proxy_pass http://10.1.65.144:81/;
 *       proxy_set_header Host $host;
 *     }
 *   然后把 base 设为 '/tianditu'（末尾不带 /）。
 *   另注意混合内容：站点若上 https，http 瓦片会被浏览器拦截，只能走同源反代或 https。
 */
export const TILE_SERVICE_BASE: string = import.meta.env.VITE_TILE_SERVICE_BASE ?? '';

/** 天地图 key（`VITE_TIANDITU_KEY`；内网 WMTS 与公网 DataServer 的 tk 不通用，需成对配置） */
export const TIANDITU_KEY: string = import.meta.env.VITE_TIANDITU_KEY ?? '';

/** 国界底图配色（按需求固定，勿随意调整） */
const LAND_COLOR = '#efefdb';
const OCEAN_COLOR = '#97b6e1';
const BORDER_COLOR = '#606266';

/** 国界底图矢量专用 pane：必须低于雷达图层，避免盖住色斑图 */
const BASE_PANE = 'qe-base-border';

/** 天地图图层代码：vec_w 矢量底图 / cva_w 中文注记（均属 w = Web 墨卡托切片集） */
type TileLayerCode = 'vec_w' | 'cva_w';

/**
 * 生成瓦片地址模板（内网 WMTS 与公网 DataServer 参数名不同，必须分别拼）。
 *
 *   · 内网 WMTS（KVP 编码）：{base}/{vec_w|cva_w}/wmts?…&LAYER=vec|cva
 *       &TILEMATRIXSET=w&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={key}
 *     注意 **路径**用带切片集后缀的 vec_w/cva_w，而 **LAYER 参数**用去后缀的 vec/cva。
 *   · 公网 DataServer：https://t{s}.tianditu.gov.cn/DataServer?T={图层}&X={x}&Y={y}&L={z}
 *
 * TILEROW 在 w 切片集中自上而下编号（第 0 行在最北），与 Leaflet 的 {y} 同向，
 * 因此不需要 TMS 翻转（既不要把 {y} 取负，也不要开 tms:true）。
 */
function tileUrlTemplate(layer: TileLayerCode): string {
  if (!TILE_SERVICE_BASE) {
    return (
      `https://t{s}.tianditu.gov.cn/DataServer?T=${layer}` +
      `&X={x}&Y={y}&L={z}&tk=${TIANDITU_KEY}`
    );
  }
  const layerCode = layer.split('_')[0];
  return (
    `${TILE_SERVICE_BASE}/${layer}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${layerCode}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles` +
    `&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${TIANDITU_KEY}`
  );
}

/**
 * 为地图叠加天地图底图与注记。
 *
 * 地址由 tileUrlTemplate 依据 TILE_SERVICE_BASE / TIANDITU_KEY 生成；
 * 两种服务都是 EPSG:3857 的 256px 切片，与地图 CRS（L.CRS.EPSG3857）直接匹配。
 *
 * @param map QEL.LMap 地图实例
 * @returns 本次添加的图层（切换底图时按此数组整体移除）
 */
export function addTiandituBase(map: LMap): L.Layer[] {
  const common: L.TileLayerOptions = {
    // 内网是单节点地址，模板里没有 {s} 占位符；仅公网回退时启用 t0~t7 子域轮询
    ...(TILE_SERVICE_BASE ? {} : { subdomains: '01234567' }),
    maxZoom: 18,
    // ★ 内网节点的切片层级若低于 18（省市级节点常只同步到 10~12 级），
    //   把此值改成实际最高层级：Leaflet 会用上级瓦片放大补齐，
    //   否则超出层级会整片请求 404、底图变空白。
    maxNativeZoom: 18
  };
  // 矢量底图
  const vec = L.tileLayer(tileUrlTemplate('vec_w'), {
    ...common,
    attribution: ''
  }).addTo(map as unknown as L.Map);
  // 中文注记层（保证地名始终压在雷达回波之上更易判读时，可调整 pane）
  const cva = L.tileLayer(tileUrlTemplate('cva_w'), common).addTo(map as unknown as L.Map);

  return [vec, cva];
}

/** 每张地图当前挂载的底图图层（切换时整体移除；卸载时必须 delete，避免持有地图引用） */
const baseLayers = new Map<LMap, L.Layer[]>();

/** 每张地图的底图切换序号：异步加载边界数据回来时，过期的切换结果直接丢弃 */
const baseTokens = new Map<LMap, number>();

/** 三份边界 GeoJSON（合计约 4MB）：首次切换到国界时加载一次并缓存 */
interface BorderGeoData {
  world: unknown;
  china: unknown;
  province: unknown;
}
let borderDataPromise: Promise<BorderGeoData> | null = null;

/** 拉取单个 GeoJSON（省界约 3MB，超时放宽到 20s） */
async function fetchGeo(url: string): Promise<unknown> {
  const resp = await fetchWithTimeout(url, 20000);
  if (!resp.ok) throw new Error('边界数据加载失败：HTTP ' + resp.status);
  return resp.json();
}

/** 加载三份边界数据（并发 + 缓存；失败不缓存，允许下次重试） */
function loadBorderData(): Promise<BorderGeoData> {
  if (!borderDataPromise) {
    borderDataPromise = Promise.all([
      fetchGeo(worldBorderUrl),
      fetchGeo(chinaBorderUrl),
      fetchGeo(provinceBorderUrl)
    ])
      .then(([world, china, province]) => ({ world, china, province }))
      .catch((e) => {
        borderDataPromise = null;
        throw e;
      });
  }
  return borderDataPromise;
}

/** 创建国界底图专用 pane（zIndex 190：低于瓦片 200 与覆盖物 400） */
function ensureBasePane(map: LMap): void {
  if (map.getPane(BASE_PANE)) return;
  const pane = map.createPane(BASE_PANE);
  pane.style.zIndex = '190';
}

/** 把一段 GeoJSON 画到底图 pane 上 */
function addGeoLayer(map: LMap, data: unknown, style: L.PathOptions): L.Layer {
  return L.geoJSON(data as never, {
    pane: BASE_PANE,
    style: () => style
  }).addTo(map as unknown as L.Map);
}

/** 移除某张地图上的全部底图图层 */
function clearBaseLayers(map: LMap): void {
  const layers = baseLayers.get(map);
  if (!layers) return;
  for (const item of layers) {
    try {
      item.remove();
    } catch {
      // 地图正在销毁时 remove 可能抛错，忽略即可
    }
  }
  baseLayers.delete(map);
}

/**
 * 应用指定底图模式（每张地图独立调用）。
 *
 * 国界模式：
 *   - 地图容器背景直接设为海洋色（最省事且不会有接缝）；
 *   - 陆地由 worldGJ / chinaGJ 多边形填充，省界只描边不填充；
 *   - 数据首次加载约 4MB，加载期间先显示海洋色，回来后补陆地。
 *
 * @param map  QEL.LMap 地图实例
 * @param mode admin=天地图；border=国界/省界矢量
 */
export async function applyBaseMap(map: LMap, mode: BaseMapMode): Promise<void> {
  const token = (baseTokens.get(map) ?? 0) + 1;
  baseTokens.set(map, token);

  clearBaseLayers(map);

  // 海洋色：国界模式用容器背景承载；切回行政时清空内联样式
  map.getContainer().style.backgroundColor = mode === 'border' ? OCEAN_COLOR : '';

  if (mode === 'admin') {
    baseLayers.set(map, addTiandituBase(map));
    return;
  }

  try {
    const data = await loadBorderData();
    // 加载期间用户又切了模式、或地图已卸载 → 丢弃本次结果
    if (baseTokens.get(map) !== token) return;

    ensureBasePane(map);
    const layers: L.Layer[] = [
      // 世界陆地 + 世界国界（1px）
      addGeoLayer(map, data.world, {
        color: BORDER_COLOR,
        weight: 1,
        fillColor: LAND_COLOR,
        fillOpacity: 1
      }),
      // 中国国界（1px）：覆盖世界数据里的中国部分
      addGeoLayer(map, data.china, {
        color: BORDER_COLOR,
        weight: 1,
        fillColor: LAND_COLOR,
        fillOpacity: 1
      }),
      // 省界（0.8px）：只描边不填充，避免盖住陆地色
      addGeoLayer(map, data.province, {
        color: BORDER_COLOR,
        weight: 0.8,
        fill: false
      })
    ];
    baseLayers.set(map, layers);
  } catch (e) {
    // 保持海洋色（用户可见异常），不静默混用天地图掩盖问题
    console.error('[mapManager] 国界底图加载失败：', e);
  }
}

/**
 * 释放某张地图的底图资源（地图卸载时调用）。
 * 不清 baseTokens 会导致 Map 持有已销毁地图引用，无法 GC。
 */
export function cleanupBaseMap(map: LMap): void {
  clearBaseLayers(map);
  baseTokens.delete(map);
}
