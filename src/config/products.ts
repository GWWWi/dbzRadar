/**
 * config/products.ts —— 静态产品目录（“产品列表”接口的数据源）
 *
 * 产品与 CINRAD 标准基数据的【矩（Moment）】一一对应，id 即字段名
 * （见 parse/cinradVolume.ts 的 MOMENT_FIELD）：
 *   dBZ  滤波后反射率（Reflectivity）             dBZ
 *   dBT  滤波前反射率（Total Reflectivity）       dBZ
 *   V    径向速度（Doppler Velocity）             m/s
 *   W    谱宽（Spectrum Width）                   m/s
 *   ZDR  差分反射率（Differential Reflectivity）  dB
 *   CC   协相关系数（Cross Correlation）         0~1
 *   KDP  差分相移率（Specific Differential Phase）°/km
 *   SNRH 水平通道信噪比（Horizontal SNR）         dB
 * ΦDP（差分相移）解析结果里也有，但不作为产品展示（调试用）。
 *
 * 第 0 个产品（dBZ）为默认产品，也是多屏对比的初始产品。
 *
 * ★ 每个色标都必须有首档透明兜底档 ★
 *   QuickEarth 的 bitmap 模式会把低于首个阈值的值钳位到第一档颜色，
 *   没有低值 alpha=0 的兜底档时，无回波区会被第一档颜色铺满（"蓝色底色"）。
 */

import type { RadarProduct } from '../types';

/**
 * 反射率类色标（dBT / dBZ 共用）：气象行业通用“蓝→青→绿→黄→橙→红→紫”，
 * 5~75 dBZ 间隔 5 dBZ，与主流雷达 PUP 产品一致。
 */
function reflectivityColorStops(): RadarProduct['colorStops'] {
  return [
    { value: -100, stop: [0, 0, 0, 0] },        // 兜底透明档：< 5 dBZ 不着色
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
    { value: 70,  stop: [203, 174, 243, 255] }, // 70：淡紫
    { value: 75,  stop: [230, 200, 250, 255] }  // 75：淡粉（极端回波）
  ];
}

/**
 * 径向速度色标：背离雷达（负）蓝系、朝向雷达（正）红系，0 附近灰白。
 * 覆盖 ±30 m/s（奈奎斯特速度 8.65 的圈会有折叠，色标按量程着色即可）。
 */
function velocityColorStops(): RadarProduct['colorStops'] {
  return [
    { value: -1000, stop: [0, 0, 0, 0] },        // 兜底透明档
    { value: -30,  stop: [0, 0, 200, 255] },     // 强负速度：深蓝
    { value: -20,  stop: [0, 90, 255, 255] },    // 中负速度：蓝
    { value: -10,  stop: [80, 200, 255, 255] },  // 弱负速度：浅蓝
    { value: 0,    stop: [200, 200, 200, 255] }, // 零速度：灰
    { value: 10,   stop: [255, 200, 80, 255] },  // 弱正速度：浅橙
    { value: 20,   stop: [255, 110, 0, 255] },   // 中正速度：橙
    { value: 30,   stop: [220, 0, 0, 255] }      // 强正速度：深红
  ];
}

/**
 * 谱宽色标：0~10 m/s。谱宽反映径向速度离散程度，
 * 大值通常对应湍流、切变区或数据质量差的区域。
 */
function spectrumWidthColorStops(): RadarProduct['colorStops'] {
  return [
    { value: -100, stop: [0, 0, 0, 0] },        // 兜底透明档
    { value: 0,    stop: [240, 250, 240, 255] }, // 0：近白（数据质量好）
    { value: 2,    stop: [170, 230, 170, 255] }, // 2：浅绿
    { value: 4,    stop: [110, 200, 110, 255] }, // 4：绿
    { value: 6,    stop: [250, 220, 90, 255] },  // 6：黄
    { value: 8,    stop: [240, 130, 40, 255] },  // 8：橙
    { value: 10,   stop: [200, 40, 40, 255] }    // 10：红（湍流/质量差）
  ];
}

/**
 * 差分反射率（ZDR）色标：-2 ~ 8 dB。
 * 大值（>3 dB）对应大水滴（强降水），接近 0 对应小冰雹/雪花。
 */
function zdrColorStops(): RadarProduct['colorStops'] {
  return [
    { value: -100, stop: [0, 0, 0, 0] },        // 兜底透明档
    { value: -2,   stop: [40, 60, 140, 255] },  // 极低：深蓝
    { value: 0,    stop: [70, 150, 220, 255] }, // 低：蓝
    { value: 1,    stop: [140, 210, 180, 255] },// 中：青绿
    { value: 2,    stop: [250, 230, 120, 255] },// 中高：黄
    { value: 4,    stop: [240, 140, 50, 255] }, // 高：橙
    { value: 6,    stop: [220, 50, 50, 255] },  // 很高：红
    { value: 8,    stop: [150, 20, 120, 255] }  // 极高：紫红
  ];
}

/**
 * 相关系数（CC）色标：0.85 ~ 1.05。
 * CC 低（<0.9）表示水平/垂直通道相干性差，常见于非气象回波、
 * 衰减严重区或数据质量差的区域，是偏振数据质量的关键判据。
 */
function ccColorStops(): RadarProduct['colorStops'] {
  return [
    { value: -100, stop: [0, 0, 0, 0] },         // 兜底透明档
    { value: 0.85, stop: [150, 30, 30, 255] },   // 低：暗红（质量差）
    { value: 0.9,  stop: [230, 90, 40, 255] },   // 偏低：橙红
    { value: 0.93, stop: [250, 180, 60, 255] },  // 中：黄
    { value: 0.96, stop: [160, 230, 120, 255] }, // 良：浅绿
    { value: 0.99, stop: [60, 190, 160, 255] },  // 优：青
    { value: 1.05, stop: [20, 120, 200, 255] }   // 极优：蓝
  ];
}

/**
 * 差分相移率（KDP）色标：-1 ~ 6 °/km。
 * KDP 是大雨判别的核心量：>1 °/km 通常对应强降雨带，
 * 且对冰雹不敏感（弥补反射率的不足）。
 */
function kdpColorStops(): RadarProduct['colorStops'] {
  return [
    { value: -100, stop: [0, 0, 0, 0] },        // 兜底透明档
    { value: -1,   stop: [90, 90, 160, 255] },  // 负值：暗蓝紫
    { value: 0,    stop: [200, 210, 230, 255] },// 0 附近：灰白
    { value: 0.3,  stop: [120, 220, 160, 255] },// 弱：浅绿
    { value: 1,    stop: [60, 200, 90, 255] },  // 中：绿
    { value: 2,    stop: [250, 220, 80, 255] }, // 较强：黄
    { value: 3.5,  stop: [240, 140, 40, 255] }, // 强：橙
    { value: 6,    stop: [210, 40, 40, 255] }   // 极强：红
  ];
}

/**
 * 水平通道信噪比（SNRH）色标：0 ~ 60 dB。
 * SNRH 低说明该距离库的水平通道信号接近底噪，偏振量（ZDR/KDP/CC）
 * 在该处不可信，通常作为偏振产品质量控制的第一道门限。
 */
function snrhColorStops(): RadarProduct['colorStops'] {
  return [
    { value: -100, stop: [0, 0, 0, 0] },         // 兜底透明档
    { value: 0,    stop: [120, 40, 40, 255] },   // 极低：暗红
    { value: 10,   stop: [220, 100, 40, 255] },  // 低：橙
    { value: 20,   stop: [250, 200, 80, 255] },  // 中低：黄
    { value: 30,   stop: [170, 230, 120, 255] }, // 中：浅绿
    { value: 45,   stop: [80, 200, 160, 255] },  // 良：青
    { value: 60,   stop: [30, 120, 200, 255] }   // 优：蓝
  ];
}

/** 静态产品目录数组（顺序即产品列表展示顺序，第 0 个为默认产品） */
export const PRODUCTS: RadarProduct[] = [
  {
    id: 'dBZ',
    name: '反射率（dBZ）',
    unit: 'dBZ',
    type: 'obs',
    colorStops: reflectivityColorStops()
  },
  {
    id: 'dBT',
    name: '原始反射率（dBT）',
    unit: 'dBZ',
    type: 'obs',
    colorStops: reflectivityColorStops()
  },
  {
    id: 'V',
    name: '径向速度（V）',
    unit: 'm/s',
    type: 'obs',
    colorStops: velocityColorStops()
  },
  {
    id: 'W',
    name: '谱宽（W）',
    unit: 'm/s',
    type: 'obs',
    colorStops: spectrumWidthColorStops()
  },
  {
    id: 'ZDR',
    name: '差分反射率（ZDR）',
    unit: 'dB',
    type: 'obs',
    colorStops: zdrColorStops()
  },
  {
    id: 'CC',
    name: '相关系数（CC）',
    unit: '',
    type: 'obs',
    colorStops: ccColorStops()
  },
  {
    id: 'KDP',
    name: '差分相移率（KDP）',
    unit: '°/km',
    type: 'obs',
    colorStops: kdpColorStops()
  },
  {
    id: 'SNRH',
    name: '信噪比（SNRH）',
    unit: 'dB',
    type: 'obs',
    colorStops: snrhColorStops()
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
