/**
 * parse/cinradVolume.ts —— RSTM 标准格式对外门面
 *
 * 实现已拆分：
 *   - rstmRadials：二进制头 / cut / 径向 / 矩解析（含 dealias）；
 *   - rstmPolar  ：经纬度 ↔ 极坐标、斜距换算、最近邻与九点取样；
 *   - rstmGrid   ：极坐标 → 等经纬度网格（多屏共享最近一次栅格化结果）。
 *
 * 本文件保留原有导出，调用方 import 路径不变。
 */

export { MOMENT_FIELD, parseRstmVolume } from './rstmRadials';
export type { RstmField } from './rstmRadials';

export {
  groundToSlantRange,
  latLonToPolar,
  polarToLatLon,
  sampleRstmNeighborhood,
  sampleRstmValue,
  slantToGroundRange
} from './rstmPolar';
export type { RstmNeighborhood } from './rstmPolar';

export { volumeToGrid } from './rstmGrid';
