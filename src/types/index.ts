/**
 * types/index.ts —— 全局 TypeScript 类型定义（数据契约）
 *
 * 集中定义平台涉及的领域模型，被以下各层共同遵守：
 *   - 解析层  parse/*        ：把二进制/文本解析为 RadarGrid
 *   - 接口层  api/*          ：获取产品列表、获取雷达文件清单与网格
 *   - 渲染层  render/*       ：把 RadarGrid 渲染为地图图层
 *   - 状态层  store/*        ：多屏 / 产品 / 时间等应用状态
 *
 * 核心约定：渲染层消费的是“笛卡尔经纬度网格 RadarGrid”：
 *   - x 为经度、y 为纬度，单位均为“度”
 *   - data 行优先（row-major），长度 = xSize * ySize
 *   - 第 0 行的纬度由 yStart 决定：yDelta>0 时第 0 行为最南行；
 *     yDelta<0 时第 0 行为最北行（QuickEarth 两种方向均支持）
 */

/** 颜色停止点：value 为数据值阈值，stop 为对应 RGBA 颜色（0~255） */
export interface ColorStop {
  /** 数据值（阈值） */
  value: number;
  /** 颜色 [红, 绿, 蓝, 透明度]，取值 0~255；透明度 < 255 用于“无回波透明” */
  stop: [number, number, number, number];
}

/**
 * 雷达产品元信息（产品列表中的一项）。
 * 产品决定了渲染配色（colorStops）与数值单位。
 */
export interface RadarProduct {
  /** 产品代码，如 'Z'（基本反射率） */
  id: string;
  /** 中文名，如 “基本反射率” */
  name: string;
  /** 单位，如 'dBZ' / 'km' / 'm/s' */
  unit: string;
  /** 色标（颜色停止点序列），供渲染层构造 QuickEarth fillColor 规则 */
  colorStops: ColorStop[];
}

/**
 * 雷达文件的数据格式：
 *   - 'mosaic'：SWAN 雷达三维拼图（Z_OTHE_RADAMOSAIC_*.bin，头部为 "diamond"）
 *   - 'rstm'  ：CINRAD 单站基数据 RSTM（Z_RADR_I_Z95xx_*.bin.bz2，魔数 "RSTM"）
 *   - 'm4'    ：MICAPS 第 4 类格点文本文件（*.m4）
 */
export type RadarFileFormat = 'mosaic' | 'rstm' | 'm4';

/**
 * 雷达文件清单项（对应 public/data/manifest.json 中的一条记录）。
 * 由 scripts/prepare-data.cjs 在准备阶段生成，
 * 前端通过 radarApi.listRadarFiles() 读取。
 */
export interface RadarFileMeta {
  /** 原始文件名（.bz2 或 .bin 或 .m4） */
  file: string;
  /** 实际 fetch 的文件名（解压后的 .bin，或原始 .bin/.m4） */
  binFile: string;
  /** 观测时刻（ISO 字符串，如 '2022-06-19T00:00:43'），时间轴据此排列 */
  time: string;
  /** 站号 / 数据标识，如 'Z9543'、'RADAMOSAIC' */
  stationId: string;
  /** 站名 / 数据名称 */
  stationName: string;
  /** 是否包含真实数据体（false 时解析器会用合成网格兜底） */
  hasData: boolean;
  /** 数据格式（见 RadarFileFormat） */
  format: RadarFileFormat;
}

/**
 * 雷达笛卡尔网格 —— 解析器的输出、渲染器的输入。
 * 所有解析器（SWAN 拼图 / CINRAD 单站 / MICAPS m4）都归一化为该结构。
 */
export interface RadarGrid {
  /** 站号 / 数据标识 */
  stationId: string;
  /** 站名 / 数据名称 */
  stationName: string;
  /** 参考纬度（站点纬度或网格中心纬度，用于地图定位提示） */
  lat: number;
  /** 参考经度 */
  lon: number;
  /** 产品代码 */
  product: string;
  /** 观测时刻（ISO 字符串） */
  time: string;
  /** 数值单位，如 'dBZ' */
  units: string;
  /** 缺测哨兵值（data 中等于该值的点表示无数据，渲染为透明） */
  undef: number;
  /** 经度起点（第 0 列经度，度） */
  xStart: number;
  /** 经度步长（列距，度，恒为正） */
  xDelta: number;
  /** 经度方向格点数（列数） */
  xSize: number;
  /** 纬度起点（第 0 行纬度，度；可为北端或南端，取决于 yDelta 符号） */
  yStart: number;
  /** 纬度步长（行距，度；负值表示第 0 行在最北） */
  yDelta: number;
  /** 纬度方向格点数（行数） */
  ySize: number;
  /** 数据体，行优先一维数组，长度 = xSize * ySize */
  data: number[];
  /** 是否为“合成兜底”网格（真实数据不可解码时为 true，UI 上会提示） */
  isSynthetic: boolean;
}
