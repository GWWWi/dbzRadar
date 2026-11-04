/**
 * parse/rstmRadials.test.ts —— RSTM 标准格式二进制解析回归测试
 *
 * ★ 为什么要这组测试 ★
 *   rstmRadials 是整个 RSTM 链路的入口（解析 → 取样 → 栅格化 → 渲染），
 *   一旦偏移、解码公式或合并规则被改坏，全链路都会静默出错（图上颜色不对但不报错）。
 *   这里用**手工构造的最小合法二进制**覆盖关键契约，不依赖 4.9MB 的真实样本：
 *     - 头部/版本/cut 数/库长的合法性校验；
 *     - 矩解码 (code - offset) / scale 与 code <= 4 缺测；
 *     - 8 位与 16 位矩；
 *     - 径向速度按奈奎斯特速度折叠（dealias）；
 *     - 同仰角长/短圈按方位合并（先到者优先）；
 *     - 层元数据、时间换算、字段映射、方位排序。
 */
import { describe, expect, it } from 'vitest';
import { MOMENT_FIELD, parseRstmVolume } from './rstmRadials';
import { UNDEF } from '../constants';

/* ─────────────── 最小合法二进制构造器 ─────────────── */

const FILE_HEADER_SIZE = 416; // GENERIC(32) + SITE(128) + TASK(256)
const CUT_SIZE = 256;
const RADIAL_HEADER_SIZE = 64;
const MOMENT_HEADER_SIZE = 32;

interface CutSpec {
  elevation: number;
  gateSize: number;
  startRange?: number;
  maxRange?: number;
  nyquist?: number;
}

interface MomentSpec {
  type: number;
  scale: number;
  offset: number;
  binLength: 1 | 2;
  /** 原始码值（未解码） */
  codes: number[];
}

interface RadialSpec {
  eleNum: number;
  azimuth: number;
  elevation: number;
  seconds?: number;
  /** 实际写入的矩类型列表（用于验证“缺失字段为空数组”） */
  moments: MomentSpec[];
}

/** 与 cinradParser 的偏移保持一致（magic/siteId/siteName/lat/lon） */
function writeAscii(u8: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) u8[offset + i] = text.charCodeAt(i);
}

/**
 * 构造一份最小可解析的 RSTM V2 缓冲区。
 * 只写解析器实际读取的字段，其余保持 0。
 */
function buildBuffer(cuts: CutSpec[], radials: RadialSpec[]): ArrayBuffer {
  let radialBytes = 0;
  for (const r of radials) {
    radialBytes += RADIAL_HEADER_SIZE;
    for (const m of r.moments) radialBytes += MOMENT_HEADER_SIZE + m.codes.length * m.binLength;
  }

  const total = FILE_HEADER_SIZE + cuts.length * CUT_SIZE + radialBytes;
  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);

  // —— GENERIC + SITE ——
  writeAscii(u8, 0, 'RSTM');
  dv.setUint16(4, 2, true); // major version = 2
  writeAscii(u8, 32, 'Z9517');
  writeAscii(u8, 40, 'TEST_RADAR');
  dv.setFloat32(72, 33.2433, true);
  dv.setFloat32(76, 118.8261, true);

  // —— TASK：cut 数量 @336 ——
  dv.setInt32(336, cuts.length, true);

  // —— CUT 配置 ——
  cuts.forEach((c, i) => {
    const b = FILE_HEADER_SIZE + i * CUT_SIZE;
    dv.setFloat32(b + 24, c.elevation, true); // 标称仰角
    dv.setInt32(b + 44, c.gateSize, true); // 库长
    dv.setInt32(b + 52, c.maxRange ?? 460_000, true); // 最大距离
    dv.setInt32(b + 60, c.startRange ?? 0, true); // 起始距离
    dv.setFloat32(b + 80, c.nyquist ?? 27.23, true); // 奈奎斯特速度
  });

  // —— 逐径向 + 逐矩 ——
  let pos = FILE_HEADER_SIZE + cuts.length * CUT_SIZE;
  for (const r of radials) {
    dv.setInt32(pos + 16, r.eleNum, true);
    dv.setFloat32(pos + 20, r.azimuth, true);
    dv.setFloat32(pos + 24, r.elevation, true);
    dv.setInt32(pos + 28, r.seconds ?? 1792281691, true); // 2026-10-18T00:01:31Z
    dv.setInt32(pos + 32, 0, true);
    dv.setInt32(pos + 40, r.moments.length, true);

    let mp = pos + RADIAL_HEADER_SIZE;
    for (const m of r.moments) {
      dv.setInt32(mp + 0, m.type, true);
      dv.setInt32(mp + 4, m.scale, true);
      dv.setInt32(mp + 8, m.offset, true);
      dv.setInt16(mp + 12, m.binLength, true);
      dv.setInt32(mp + 16, m.codes.length * m.binLength, true);
      for (let i = 0; i < m.codes.length; i++) {
        if (m.binLength === 1) u8[mp + MOMENT_HEADER_SIZE + i] = m.codes[i];
        else dv.setUint16(mp + MOMENT_HEADER_SIZE + i * 2, m.codes[i], true);
      }
      mp += MOMENT_HEADER_SIZE + m.codes.length * m.binLength;
    }
    pos = mp;
  }

  return buf;
}

/** 单层单径向的常用模板：dBZ scale=2 offset=66 */
function oneRadial(codes: number[], extra: Partial<RadialSpec> = {}): RadialSpec {
  return {
    eleNum: 1,
    azimuth: 90,
    elevation: 0.5,
    seconds: 1792281691,
    moments: [{ type: 2, scale: 2, offset: 66, binLength: 1, codes }],
    ...extra
  };
}

/* ─────────────── 合法性校验 ─────────────── */

describe('parseRstmVolume 合法性校验', () => {
  it('缓冲区过短返回 null', () => {
    expect(parseRstmVolume(new ArrayBuffer(64))).toBeNull();
  });

  it('魔数不是 RSTM 返回 null', () => {
    const buf = buildBuffer([{ elevation: 0.5, gateSize: 250 }], [oneRadial([100])]);
    new Uint8Array(buf)[0] = 0x58; // 'X'
    expect(parseRstmVolume(buf)).toBeNull();
  });

  it('版本号不是 2 返回 null', () => {
    const buf = buildBuffer([{ elevation: 0.5, gateSize: 250 }], [oneRadial([100])]);
    new DataView(buf).setUint16(4, 1, true);
    expect(parseRstmVolume(buf)).toBeNull();
  });

  it('cut 数为 0 返回 null', () => {
    const buf = buildBuffer([{ elevation: 0.5, gateSize: 250 }], [oneRadial([100])]);
    new DataView(buf).setInt32(336, 0, true);
    expect(parseRstmVolume(buf)).toBeNull();
  });

  it('cut 数超过上限返回 null', () => {
    const buf = buildBuffer([{ elevation: 0.5, gateSize: 250 }], [oneRadial([100])]);
    new DataView(buf).setInt32(336, 33, true);
    expect(parseRstmVolume(buf)).toBeNull();
  });

  it('库长非法（0）返回 null', () => {
    const buf = buildBuffer([{ elevation: 0.5, gateSize: 250 }], [oneRadial([100])]);
    new DataView(buf).setInt32(FILE_HEADER_SIZE + 44, 0, true);
    expect(parseRstmVolume(buf)).toBeNull();
  });
});

/* ─────────────── 层与元数据 ─────────────── */

describe('parseRstmVolume 层组织与元数据', () => {
  it('解析出正确的站点、仰角与库长', () => {
    const buf = buildBuffer(
      [{ elevation: 0.5, gateSize: 250, startRange: 0, maxRange: 460_000, nyquist: 27.23 }],
      [oneRadial([100, 110, 120])]
    );
    const vol = parseRstmVolume(buf);
    expect(vol).not.toBeNull();
    expect(vol!.stationId).toBe('Z9517');
    expect(vol!.lat).toBeCloseTo(33.2433, 3);
    expect(vol!.lon).toBeCloseTo(118.8261, 3);
    expect(vol!.elevations).toEqual([0.5]);
    expect(vol!.layers).toHaveLength(1);
    expect(vol!.layers[0]).toHaveLength(1);
    expect(vol!.gateSizes[0]).toBe(250);
    expect(vol!.startRanges[0]).toBe(0);
    expect(vol!.maxRanges[0]).toBe(460_000);
    expect(vol!.nyquists[0]).toBeCloseTo(27.23, 2);
    expect(vol!.gateCounts[0]).toBe(3);
  });

  it('方位按升序排列', () => {
    const buf = buildBuffer(
      [{ elevation: 0.5, gateSize: 250 }],
      [oneRadial([1], { azimuth: 200 }), oneRadial([1], { azimuth: 10 }), oneRadial([1], { azimuth: 100 })]
    );
    const vol = parseRstmVolume(buf)!;
    expect(vol.layers[0].map((r) => r.azimuth)).toEqual([10, 100, 200]);
  });

  it('多个仰角按角度升序分层', () => {
    const buf = buildBuffer(
      [
        { elevation: 1.5, gateSize: 250 },
        { elevation: 0.5, gateSize: 250 }
      ],
      [
        oneRadial([1], { eleNum: 1, elevation: 1.5, azimuth: 10 }),
        oneRadial([1], { eleNum: 2, elevation: 0.5, azimuth: 10 })
      ]
    );
    const vol = parseRstmVolume(buf)!;
    expect(vol.elevations).toEqual([0.5, 1.5]);
  });

  it('同仰角的长/短圈按方位合并：先到者保留（长圈优先）', () => {
    // cut1 = 长圈（1840 库），cut2 = 短圈（920 库），同一仰角、同一方位
    const longCodes = new Array(1840).fill(100);
    const shortCodes = new Array(920).fill(150);
    const buf = buildBuffer(
      [
        { elevation: 0.5, gateSize: 250, maxRange: 460_000, nyquist: 8.65 },
        { elevation: 0.5, gateSize: 250, maxRange: 230_000, nyquist: 27.23 }
      ],
      [
        oneRadial(longCodes, { eleNum: 1, azimuth: 90 }),
        oneRadial(shortCodes, { eleNum: 2, azimuth: 90 })
      ]
    );
    const vol = parseRstmVolume(buf)!;
    expect(vol.layers).toHaveLength(1); // 同仰角合并为一层
    expect(vol.layers[0]).toHaveLength(1); // 同方位只保留一条
    expect(vol.layers[0][0].fields.dBZ.length).toBe(1840); // 保留了长圈
    expect(vol.maxRanges[0]).toBe(460_000);
  });

  it('同仰角不同方位的两圈都保留', () => {
    const buf = buildBuffer(
      [
        { elevation: 0.5, gateSize: 250 },
        { elevation: 0.5, gateSize: 250 }
      ],
      [
        oneRadial([1], { eleNum: 1, azimuth: 90 }),
        oneRadial([2], { eleNum: 2, azimuth: 180 })
      ]
    );
    const vol = parseRstmVolume(buf)!;
    expect(vol.layers[0]).toHaveLength(2);
  });
});

/* ─────────────── 矩解码 ─────────────── */

describe('parseRstmVolume 矩解码', () => {
  it('按 (code - offset) / scale 解码，code <= 4 为缺测', () => {
    // scale=2, offset=66：code 5 → -30.5，code 100 → 17，code 200 → 67
    const buf = buildBuffer(
      [{ elevation: 0.5, gateSize: 250 }],
      [oneRadial([0, 4, 5, 100, 200])]
    );
    const vol = parseRstmVolume(buf)!;
    const dBZ = vol.layers[0][0].fields.dBZ;
    expect(dBZ[0]).toBe(UNDEF); // code 0
    expect(dBZ[1]).toBe(UNDEF); // code 4
    expect(dBZ[2]).toBeCloseTo(-30.5, 6);
    expect(dBZ[3]).toBeCloseTo(17, 6);
    expect(dBZ[4]).toBeCloseTo(67, 6);
  });

  it('16 位矩按小端解析', () => {
    const buf = buildBuffer(
      [{ elevation: 0.5, gateSize: 250 }],
      [
        oneRadial([1], {
          moments: [{ type: 10, scale: 100, offset: 50, binLength: 2, codes: [0, 5, 5015] }]
        })
      ]
    );
    const vol = parseRstmVolume(buf)!;
    const phidp = vol.layers[0][0].fields.PHIDP;
    expect(phidp).toHaveLength(3);
    expect(phidp[0]).toBe(UNDEF);
    expect(phidp[1]).toBeCloseTo((5 - 50) / 100, 4);
    // 字段数组是 Float32Array，只有约 7 位有效数字 → 容差取 1e-4
    expect(phidp[2]).toBeCloseTo((5015 - 50) / 100, 4);
  });

  it('字段类型映射与未知类型忽略', () => {
    const buf = buildBuffer(
      [{ elevation: 0.5, gateSize: 250 }],
      [
        oneRadial([1], {
          moments: [
            { type: 1, scale: 2, offset: 66, binLength: 1, codes: [100] }, // dBT
            { type: 2, scale: 2, offset: 66, binLength: 1, codes: [100] }, // dBZ
            { type: 7, scale: 16, offset: 130, binLength: 1, codes: [146] }, // ZDR
            { type: 9, scale: 200, offset: 5, binLength: 1, codes: [205] }, // CC
            { type: 16, scale: 2, offset: 20, binLength: 1, codes: [100] }, // SNRH
            { type: 5, scale: 1, offset: 0, binLength: 1, codes: [9] } // SQI：不支持，应忽略
          ]
        })
      ]
    );
    const vol = parseRstmVolume(buf)!;
    const f = vol.layers[0][0].fields;
    expect(f.dBT).toHaveLength(1);
    expect(f.dBZ).toHaveLength(1);
    expect(f.ZDR[0]).toBeCloseTo((146 - 130) / 16, 6);
    expect(f.CC[0]).toBeCloseTo((205 - 5) / 200, 6);
    expect(f.SNRH[0]).toBeCloseTo((100 - 20) / 2, 6);
    // 未出现在数据里的字段是零长数组（共享 EMPTY_FIELD）
    expect(f.KDP).toHaveLength(0);
    expect(f.W).toHaveLength(0);
  });

  it('MOMENT_FIELD 与解析出的字段名一一对应', () => {
    expect(MOMENT_FIELD.dBZ).toBe(2);
    expect(MOMENT_FIELD.V).toBe(3);
    expect(MOMENT_FIELD.SNRH).toBe(16);
    expect(Object.keys(MOMENT_FIELD).sort()).toEqual(
      ['CC', 'KDP', 'PHIDP', 'SNRH', 'V', 'W', 'ZDR', 'dBT', 'dBZ'].sort()
    );
  });
});

/* ─────────────── 速度折叠（dealias） ─────────────── */

describe('parseRstmVolume 径向速度折叠', () => {
  it('超出奈奎斯特速度的值被折叠回 [-nyquist, nyquist)', () => {
    const nyquist = 27.23;
    // V: scale=2, offset=129 → 原始 (code-129)/2
    // code 129 → 0；code 209 → 40 → 折叠 40-54.46 = -14.46
    // code 49  → -40 → 折叠 -40+54.46 = 14.46
    const buf = buildBuffer(
      [{ elevation: 0.5, gateSize: 250, nyquist }],
      [
        oneRadial([1], {
          moments: [{ type: 3, scale: 2, offset: 129, binLength: 1, codes: [129, 209, 49] }]
        })
      ]
    );
    const vol = parseRstmVolume(buf)!;
    const v = vol.layers[0][0].fields.V;
    expect(v[0]).toBeCloseTo(0, 6);
    // Float32Array 精度限制 → 容差 1e-4
    expect(v[1]).toBeCloseTo(40 - 2 * nyquist, 4);
    expect(v[2]).toBeCloseTo(-40 + 2 * nyquist, 4);
    // 全部落在量程内
    for (let i = 0; i < v.length; i++) {
      expect(Math.abs(v[i])).toBeLessThanOrEqual(nyquist + 1e-9);
    }
  });

  it('缺测值不参与折叠', () => {
    const buf = buildBuffer(
      [{ elevation: 0.5, gateSize: 250, nyquist: 27.23 }],
      [oneRadial([1], { moments: [{ type: 3, scale: 2, offset: 129, binLength: 1, codes: [0, 2] }] })]
    );
    const vol = parseRstmVolume(buf)!;
    const v = vol.layers[0][0].fields.V;
    expect(v[0]).toBe(UNDEF);
    expect(v[1]).toBe(UNDEF);
  });

  it('层的奈奎斯特速度取 V 实际来源圈', () => {
    // 长圈（无 V，8.65）先到，短圈（有 V，27.23）后到
    const buf = buildBuffer(
      [
        { elevation: 0.5, gateSize: 250, nyquist: 8.65 },
        { elevation: 0.5, gateSize: 250, nyquist: 27.23 }
      ],
      [
        oneRadial([100], { eleNum: 1, azimuth: 90 }),
        oneRadial([1], {
          eleNum: 2,
          azimuth: 100,
          moments: [{ type: 3, scale: 2, offset: 129, binLength: 1, codes: [129] }]
        })
      ]
    );
    const vol = parseRstmVolume(buf)!;
    expect(vol.nyquists[0]).toBeCloseTo(27.23, 2);
  });
});

/* ─────────────── 时间 ─────────────── */

describe('parseRstmVolume 时间换算', () => {
  it('按 Unix 基准（1970）换算，与文件名时刻一致', () => {
    // 1792281691 = 2026-10-18T00:01:31Z
    const buf = buildBuffer(
      [{ elevation: 0.5, gateSize: 250 }],
      [oneRadial([1], { seconds: 1792281691 })]
    );
    const vol = parseRstmVolume(buf)!;
    expect(vol.time).toBe('2026-10-18T00:01:31');
  });

  it('秒数为 0 时返回空串', () => {
    const buf = buildBuffer(
      [{ elevation: 0.5, gateSize: 250 }],
      [oneRadial([1], { seconds: 0 })]
    );
    const vol = parseRstmVolume(buf)!;
    expect(vol.time).toBe('');
  });
});
