/**
 * config/products.ts —— 静态产品目录（“产品列表”接口的数据源）
 *
 * 平台以【雷达反射率（dBZ）】为主要显示产品，因此第一个产品即基本反射率，
 * 也是多屏对比时的默认产品。
 *
 * 每个产品包含：
 *   - id         ：产品代码
 *   - name       ：中文名（显示在左侧产品列表）
 *   - unit       ：数值单位（显示在图例上）
 *   - colorStops ：色标。渲染层用它构造 QuickEarth 的 fillColor 分级填色规则，
 *                  低于首个阈值或等于缺测值的格点渲染为透明。
 *
 * 反射率色标采用气象行业通用的“蓝→青→绿→黄→橙→红→紫”分级配色，
 * 阈值间隔 5 dBZ，与主流雷达 PUP 产品一致，便于业务判读。
 */

import type { RadarProduct } from '../types';

/**
 * 中央气象台（NMC，nmc.cn）全国雷达拼图【组合反射率】标准色标。
 * 分档：5~70 dBZ，间隔 5，共 14 档。
 * 颜色序列：中蓝→浅青→浅绿→绿→深绿→黄绿→黄→金黄→橙→红→深红→品红→紫→淡紫。
 * 多个反射率类产品（基本反射率 / 组合反射率）共用同一套配色，
 * 保证不同屏之间对比时颜色语义完全一致。
 *
 * ★ 注意首档透明 ★
 * QuickEarth 的 bitmap（格点分级填色）模式会把【低于首个阈值的值钳位到
 * 第一档颜色】，因此必须在最前面加一个 value 很低、alpha=0 的透明档，
 * 让无回波 / 噪声底（< 5 dBZ）区域不着色，否则整幅网格会被第一档
 * 颜色铺满形成"蓝色底色"。（渲染层还会把低于首档的值归入缺测双保险）
 */
function reflectivityColorStops() {
  return [
    { value: -100, stop: [0, 0, 0, 0] },        // 兜底透明档：< 5 dBZ 全部不着色
    { value: 5,   stop: [66, 118, 255, 255] },  //  5：中蓝（弱回波/地物杂波）
    { value: 10,  stop: [100, 217, 255, 255] }, // 10：浅青蓝
    { value: 15,  stop: [94, 227, 154, 255] },  // 15：浅绿
    { value: 20,  stop: [58, 199, 87, 255] },   // 20：绿
    { value: 25,  stop: [26, 133, 61, 255] },   // 25：深绿
    { value: 30,  stop: [156, 220, 68, 255] },  // 30：黄绿
    { value: 35,  stop: [254, 235, 61, 255] },  // 35：黄
    { value: 40,  stop: [253, 170, 48, 255] },  // 40：金黄
    { value: 45,  stop: [250, 99, 42, 255] },   // 45：橙
    { value: 50,  stop: [234, 33, 33, 255] },   // 50：红
    { value: 55,  stop: [187, 27, 75, 255] },   // 55：深红
    { value: 60,  stop: [208, 63, 197, 255] },  // 60：品红
    { value: 65,  stop: [155, 88, 224, 255] },  // 65：紫
    { value: 70,  stop: [203, 174, 243, 255] }  // 70：淡紫
  ] as RadarProduct['colorStops'];
}

/** 静态产品目录数组（顺序即产品列表展示顺序，第 0 个为默认产品） */
export const PRODUCTS: RadarProduct[] = [
  {
    id: 'Z',
    name: '基本反射率',
    unit: 'dBZ',
    colorStops: reflectivityColorStops()
  },
  {
    id: 'CR',
    name: '组合反射率',
    unit: 'dBZ',
    colorStops: reflectivityColorStops()
  },
  {
    id: 'ETV',
    name: '回波顶高',
    unit: 'km',
    colorStops: [
      { value: -100, stop: [0, 0, 0, 0] },   // 兜底透明档（同反射率说明）
      { value: 3,  stop: [166, 242, 143, 255] },
      { value: 6,  stop: [61, 186, 61, 255] },
      { value: 9,  stop: [253, 221, 92, 255] },
      { value: 12, stop: [240, 140, 40, 255] },
      { value: 15, stop: [240, 80, 80, 255] },
      { value: 18, stop: [190, 0, 120, 255] }
    ]
  },
  {
    id: 'V',
    name: '径向速度',
    unit: 'm/s',
    colorStops: [
      { value: -1000, stop: [0, 0, 0, 0] },       // 兜底透明档：< -30 m/s 不着色
      { value: -30, stop: [0, 0, 255, 255] },     // 负速度（远离雷达，蓝系）
      { value: -15, stop: [0, 200, 255, 255] },
      { value: 0,   stop: [210, 210, 210, 255] }, // 0 附近：灰
      { value: 15,  stop: [255, 180, 0, 255] },
      { value: 30,  stop: [255, 0, 0, 255] }      // 正速度（朝向雷达，红系）
    ]
  }
];

/** 获取完整产品列表（供 productApi 使用） */
export function getProductList(): RadarProduct[] {
  return PRODUCTS;
}

/** 按产品代码查找产品元信息；找不到时返回 undefined */
export function getProductById(id: string): RadarProduct | undefined {
  return PRODUCTS.find((p) => p.id === id);
}
