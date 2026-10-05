'use strict';

const ExcelJS = require('exceljs');
const { ZipArchive } = require('archiver');
const { buildQrData } = require('./codes');
const { toSvg } = require('./qr');

const TEXT = { numFmt: '@' };

// 串流寫出 Excel：工作表 labels，欄位 sn / id / qrcodedata / checkcode，全部是文字格式。
// includeCheckcode 為 false（不使用驗證碼）時省略 checkcode 欄。
async function writeExcel(stream, labels, { baseUrl, includeCheckcode = true }) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    useSharedStrings: false,
  });
  const sheet = workbook.addWorksheet('labels');
  sheet.columns = [
    { header: 'sn', key: 'sn', width: 8, style: TEXT },
    { header: 'id', key: 'id', width: 10, style: TEXT },
    { header: 'qrcodedata', key: 'qrcodedata', width: 44, style: TEXT },
    ...(includeCheckcode ? [{ header: 'checkcode', key: 'checkcode', width: 12, style: TEXT }] : []),
  ];
  for (const l of labels) {
    const values = [String(l.sn), l.product_id, buildQrData(baseUrl, l.product_id, l.code)];
    if (includeCheckcode) values.push(l.checkcode);
    const row = sheet.addRow(values);
    row.eachCell((cell) => {
      cell.numFmt = '@';
    });
    row.commit();
  }
  sheet.commit();
  await workbook.commit();
}

// 串流寫出 ZIP，每張標籤一個 {sn}.svg；一次只讓少量檔案排隊，避免 10 萬張全進記憶體
async function writeSvgZip(stream, labels, { baseUrl, ecLevel, margin }) {
  // 耗時主要在 QR 編碼（每張約 0.5 ms）；壓縮用 level 1，檔案略大但快約 20%
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const done = new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(stream);

  const HIGH_WATER = 500;
  let appended = 0;
  let processed = 0;
  let wake = null;
  archive.on('entry', () => {
    processed++;
    if (wake && appended - processed < HIGH_WATER / 2) {
      const fn = wake;
      wake = null;
      fn();
    }
  });

  for (const l of labels) {
    const svg = toSvg(buildQrData(baseUrl, l.product_id, l.code), { ecLevel, margin });
    archive.append(svg, { name: `${l.sn}.svg` });
    appended++;
    if (appended - processed >= HIGH_WATER) {
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  }
  await archive.finalize();
  await done;
}

module.exports = { writeExcel, writeSvgZip };
