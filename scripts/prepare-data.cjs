/**
 * scripts/prepare-data.cjs —— 测试数据准备脚本（Node CommonJS）
 *
 * 职责（npm run prepare:data）：
 *   1. 遍历 public/data/*.bz2，用 compressjs 解压出同名 .bin；
 *   2. 登记 public/data 下已存在的 SWAN 拼图 Z_OTHE_RADAMOSAIC_*.bin；
 *   3. 若不存在任何 .m4 文件，则生成一个【MICAPS 第 4 类】反射率示例数据
 *      （川渝区域 0.25° 网格的高斯回波团块），用于验证 m4 格式支持；
 *   4. 汇总生成 public/data/manifest.json（按时间升序），
 *      供前端 radarApi.fetchRadarFileList() 读取。
 *
 * 文件名约定与解析规则：
 *   - CINRAD 单站：Z_RADR_I_<站号>_<YYYYMMDDHHmmSS>_O_DOR_SA_CAP_FMT.bin.bz2
 *   - SWAN 拼图　：Z_OTHE_RADAMOSAIC_<YYYYMMDDHHmmSS>.bin
 */

const fs = require('fs');
const path = require('path');

let Bzip2;
try {
  ({ Bzip2 } = require('compressjs'));
} catch {
  Bzip2 = null; // 未安装依赖时跳过解压，仅登记已有文件
}

const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

/** 14 位时间串 → ISO（北京时间直存，不再做时区换算） */
function digitsToIso(t) {
  return (
    t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8) +
    'T' + t.slice(8, 10) + ':' + t.slice(10, 12) + ':' + t.slice(12, 14)
  );
}

/**
 * 从 CINRAD 单站文件名解析站号与时刻。
 * 形如 Z_RADR_I_Z9543_20220619000043_O_DOR_SA_CAP_FMT.bin.bz2
 */
function parseRstmFileName(fileName) {
  const m = fileName.match(/_I_(Z[A-Z0-9]+)_(\d{14})_O_/);
  if (m) return { stationId: m[1], time: digitsToIso(m[2]) };
  const m2 = fileName.match(/Z[A-Z0-9]+_(\d{14})/);
  if (m2) return { stationId: '', time: digitsToIso(m2[1]) };
  return { stationId: '', time: null };
}

/** 读取定长 ASCII（遇 0 截止） */
function readAscii(buf, start, len) {
  let s = '';
  for (let i = start; i < start + len && i < buf.length; i++) {
    const c = buf[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** 判断缓冲区是否全 0 */
function isAllZero(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

/* ────────────── 1) bz2 解压 ────────────── */
const manifest = [];
const addedBin = new Set();

if (fs.existsSync(DATA_DIR)) {
  const bz2Files = fs.readdirSync(DATA_DIR).filter((f) => f.toLowerCase().endsWith('.bz2'));
  for (const file of bz2Files) {
    const binName = file.replace(/\.bz2$/i, '.bin'); // 保持旧项目命名：<原名>.bin.bin
    const raw = fs.readFileSync(path.join(DATA_DIR, file));

    let out;
    try {
      if (!Bzip2) throw new Error('compressjs 未安装');
      out = Bzip2.decompressFile(raw);
    } catch (e) {
      console.warn(`[prepare] ${file} 不是合法 bz2（${e.message}），视为无真实数据。`);
      out = Buffer.alloc(0);
    }
    fs.writeFileSync(path.join(DATA_DIR, binName), out);

    const { stationId, time } = parseRstmFileName(file);
    const magic = out.length >= 4 ? readAscii(out, 0, 4) : '';
    const hasData = !isAllZero(out) && magic === 'RSTM';

    manifest.push({
      file,
      binFile: binName,
      time: time || '',
      stationId: stationId || '',
      stationName: (hasData ? readAscii(out, 40, 20) : '') || stationId || '',
      hasData,
      format: 'rstm'
    });
    addedBin.add(binName);
    console.log(`[prepare] ${file} -> ${binName} (bytes=${out.length}, magic=${magic || '-'})`);
  }

  /* ────────────── 2) 登记已有拼图 .bin ────────────── */
  for (const binName of fs.readdirSync(DATA_DIR).filter((f) => f.toLowerCase().endsWith('.bin'))) {
    if (addedBin.has(binName)) continue;
    const mm = binName.match(/RADAMOSAIC_(\d{14})/i);
    if (mm) {
      manifest.push({
        file: binName,
        binFile: binName,
        time: digitsToIso(mm[1]),
        stationId: 'RADAMOSAIC',
        stationName: 'SWAN雷达拼图',
        hasData: true,
        format: 'mosaic'
      });
      console.log(`[prepare] ${binName} -> 雷达拼图 (mosaic)`);
    }
  }
} else {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* ────────────── 3) 生成 MICAPS m4 示例 ────────────── */
const M4_SAMPLE = path.join(DATA_DIR, 'REFE_COMPOSITE_20240621080000.m4');
if (!fs.existsSync(M4_SAMPLE)) {
  // 川渝区域：100~114°E、23~35°N，0.25° 格距 → 57 列 × 49 行
  const xSize = 57, ySize = 49;
  const lonStart = 100.0, latStart = 35.0; // 第 0 行为最北行 → 纬度格距取负
  const dLon = 0.25, dLat = -0.25;

  // 三个高斯回波团块（模拟一次飑线过程）：[中心经度, 中心纬度, 峰值dBZ, σ°]
  const cells = [
    [105.5, 29.5, 58, 1.6],
    [107.8, 27.5, 47, 1.2],
    [111.0, 31.0, 38, 2.0]
  ];

  /** 计算某格点的 dBZ（各团块贡献取最大值） */
  function dbzAt(lon, lat) {
    let peak = 0;
    for (const [cx, cy, amp, sig] of cells) {
      const dx = lon - cx, dy = lat - cy;
      const v = amp * Math.exp(-(dx * dx + dy * dy) / (2 * sig * sig));
      if (v > peak) peak = v;
    }
    return peak < 1 ? 9999 : Math.round(peak); // <1dBZ 视为缺测
  }

  const rows = [];
  for (let r = 0; r < ySize; r++) {
    const row = [];
    for (let c = 0; c < xSize; c++) {
      row.push(dbzAt(lonStart + c * dLon, latStart + r * dLat));
    }
    rows.push(row.map((v) => String(v).padStart(6)).join(''));
  }

  const header =
    'diamond 4 2024年06月21日08时组合反射率拼图示例\n' +
    ['2024', '06', '21', '08', '0', '0',                    // 年 月 日 时 时效 层次
     String(dLon), String(dLat),                           // 经度格距 纬度格距
     String(lonStart), '114.00', String(latStart), '23.00',// 起止经纬度
     String(xSize), String(ySize),                         // 纬向/经向格点数
     '5', '15', '65', '1', '45'                            // 等值线间隔/起止值/平滑/加粗
    ].join(' ') + '\n';

  fs.writeFileSync(
    M4_SAMPLE,
    header + rows.join('\n') + '\n',
    'utf-8'
  );
  console.log(`[prepare] 已生成 MICAPS m4 示例：${path.basename(M4_SAMPLE)} (${xSize}×${ySize})`);
}

// 登记 m4 示例进清单
manifest.push({
  file: path.basename(M4_SAMPLE),
  binFile: path.basename(M4_SAMPLE),
  time: '2024-06-21T08:00:00',
  stationId: 'MICAPS_M4',
  stationName: 'MICAPS格点(示例)',
  hasData: true,
  format: 'm4'
});

/* ────────────── 4) 输出清单 ────────────── */
manifest.sort((a, b) => (a.time && b.time ? (a.time < b.time ? -1 : 1) : a.time ? -1 : 1));
fs.writeFileSync(
  path.join(DATA_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf-8'
);
console.log(`[prepare] manifest.json 已生成，共 ${manifest.length} 条。`);
