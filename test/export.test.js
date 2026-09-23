'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const ExcelJS = require('exceljs');
const { writeExcel, writeSvgZip } = require('../src/lib/export');
const labels = require('../src/services/labels');
const { setup, seedLabel } = require('./helpers');

function collect(stream) {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  return new Promise((resolve) => stream.on('end', () => resolve(Buffer.concat(chunks))));
}

test('Excel：工作表 labels，欄位順序正確，值與格式都是文字', async () => {
  const { db, config } = setup();
  // 全數字開頭的產品碼，確認不會被轉成數字
  const { batchId } = seedLabel(db, { productId: '0012AB', quantity: 5 });

  const out = new PassThrough();
  const buffered = collect(out);
  await writeExcel(out, labels.iterateBatchLabels(db, batchId), { baseUrl: config.baseUrl });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buffered);

  const sheet = wb.getWorksheet('labels');
  assert.ok(sheet, '找不到 labels 工作表');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['sn', 'id', 'qrcodedata', 'checkcode']);
  assert.equal(sheet.rowCount, 6);

  const rows = db.prepare('SELECT * FROM labels WHERE batch_id = ? ORDER BY sn').all(batchId);
  rows.forEach((l, i) => {
    const row = sheet.getRow(i + 2);
    assert.deepEqual(row.values.slice(1), [String(l.sn), '0012AB', `HTTPS://Q.CO/0012AB/${l.code}`, l.checkcode]);
    for (let c = 1; c <= 4; c++) {
      const cell = row.getCell(c);
      assert.equal(cell.type, ExcelJS.ValueType.String, `第 ${i + 2} 列第 ${c} 欄不是文字`);
      assert.equal(cell.numFmt, '@');
    }
  });
});

test('分頁讀取：跨頁時不漏筆也不重複', () => {
  const { db } = setup();
  const { batchId } = seedLabel(db, { quantity: 25 });
  const sns = [...labels.iterateBatchLabels(db, batchId, 7)].map((l) => l.sn);
  assert.deepEqual(sns, Array.from({ length: 25 }, (_, i) => i + 1));
});

test('SVG ZIP：每張標籤一個 {sn}.svg', async () => {
  const { db, config } = setup();
  const { batchId } = seedLabel(db, { quantity: 3 });
  const out = new PassThrough();
  const buffered = collect(out);
  await writeSvgZip(out, labels.iterateBatchLabels(db, batchId), {
    baseUrl: config.baseUrl,
    ecLevel: 'M',
    margin: 2,
  });
  const zip = await buffered;
  assert.equal(zip.subarray(0, 2).toString(), 'PK');
  for (const name of ['1.svg', '2.svg', '3.svg']) assert.ok(zip.includes(Buffer.from(name)), `缺少 ${name}`);
  assert.ok(!zip.includes(Buffer.from('4.svg')));
});

test('批次產生：10 萬筆在單一 transaction 內數秒完成', () => {
  const { db } = setup();
  labels.createProduct(db, { id: 'A12B3C', name: '大量' });
  const start = Date.now();
  const batchId = labels.createBatch(db, { productId: 'A12B3C', quantity: 100000 });
  const ms = Date.now() - start;
  const { n, uniq } = db
    .prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT code) AS uniq FROM labels WHERE batch_id = ?')
    .get(batchId);
  assert.equal(n, 100000);
  assert.equal(uniq, 100000);
  assert.ok(ms < 10000, `花了 ${ms} ms`);
});

test('批次數量超過上限時拒絕', () => {
  const { db } = setup();
  labels.createProduct(db, { id: 'A12B3C', name: 'x' });
  assert.throws(() => labels.createBatch(db, { productId: 'A12B3C', quantity: 100001 }), RangeError);
  assert.throws(() => labels.createBatch(db, { productId: 'A12B3C', quantity: 0 }), RangeError);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batches').get().n, 0);
});
