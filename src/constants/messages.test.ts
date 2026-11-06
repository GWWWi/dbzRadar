/**
 * constants/messages.test.ts —— 提示文案纯函数回归测试
 *
 * 重点：
 *   - 无数据文案在没有“最近可用”时次时不能拼出空括号；
 *   - 上传来源标签必须带文件名（多屏 / 多文件时靠它区分数据来源）；
 *   - 坐标查询的来源说明必须随格式变化（m4 / 拼图 / RSTM 基数据），
 *     否则现场会把“不同文件数值不同”当成取值 bug。
 */
import { describe, expect, it } from 'vitest';
import { noDataText, querySourceOf, QUERY_DIFF_TIP, STATUS, uploadDataLabel } from './messages';

describe('noDataText', () => {
  it('没有最近可用时次时只给基础文案，不出现空括号', () => {
    expect(noDataText('')).toBe(STATUS.noData);
    expect(noDataText('')).not.toContain('（）');
  });

  it('有最近可用时次时追加到括号里', () => {
    expect(noDataText('10-18 03:17:55')).toBe('该时次无数据（最近可用 10-18 03:17:55）');
  });
});

describe('uploadDataLabel', () => {
  it('带上文件名，便于多屏 / 多文件区分来源', () => {
    expect(uploadDataLabel('Z_RADR_I_Z9517.bin')).toBe('上传数据 · Z_RADR_I_Z9517.bin');
  });
});

describe('querySourceOf（不同文件后缀的取值口径说明）', () => {
  it('.m4 标注为格点产品（最近邻取值）', () => {
    const s = querySourceOf({ format: 'm4', isVolume: false, isSynthetic: false, elevation: -1 });
    expect(s.label).toBe('MICAPS m4 格点（最近邻取值）');
    expect(s.tip).toBe(QUERY_DIFF_TIP);
  });

  it('SWAN 拼图标注为拼图格点', () => {
    const s = querySourceOf({
      format: 'mosaic',
      isVolume: false,
      isSynthetic: false,
      elevation: -1
    });
    expect(s.label).toContain('SWAN 拼图');
    expect(s.label).toContain('最近邻');
  });

  it('RSTM 基数据带当前仰角，并标明是原始径向（未格点化）', () => {
    const s = querySourceOf({ format: 'rstm', isVolume: true, isSynthetic: false, elevation: 0.5 });
    expect(s.label).toBe('RSTM 基数据 0.5°（原始径向）');
  });

  it('合成兜底优先于格式：提示示意数据、禁止业务判断', () => {
    const s = querySourceOf({
      format: 'rstm',
      isVolume: false,
      isSynthetic: true,
      elevation: -1
    });
    expect(s.label).toContain('示意数据');
    expect(s.tip).toContain('禁止用于任何业务判断');
  });

  it('.bz2 追加“数值与解压后一致”的说明', () => {
    const s = querySourceOf({
      format: 'm4',
      isVolume: false,
      isSynthetic: false,
      elevation: -1,
      compressed: true
    });
    expect(s.tip).toContain('.bz2');
    expect(s.tip).toContain('完全一致');
  });
});
