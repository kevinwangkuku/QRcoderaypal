'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const ExcelJS = require('exceljs');
const { setup, seedLabel, AUTH } = require('./helpers');

const OFF = { CHECKCODE_ENABLED: 'false' };

test('關閉驗證碼：首次查詢顯示正品，沒有驗證碼輸入欄', async () => {
  const { app, db } = setup(OFF);
  const { label } = seedLabel(db);
  const res = await request(app).get(`/A12B3C/${label.code}`).expect(200);
  assert.match(res.text, /✅ 正品查詢成功/);
  assert.match(res.text, /此防偽碼為第一次被查詢/);
  assert.doesNotMatch(res.text, /name="checkcode"/);
  assert.doesNotMatch(res.text, /驗證碼/);
});

test('關閉驗證碼：第二次查詢顯示警告與聯絡方式，不再顯示正品', async () => {
  const { app, db } = setup({ ...OFF, CONTACT_PHONE: '02-8757-8588' });
  const { label } = seedLabel(db);
  await request(app).get(`/A12B3C/${label.code}`);
  const res = await request(app).get(`/A12B3C/${label.code}`).expect(200);
  assert.match(res.text, /⚠️ 此防偽碼已被查詢過/);
  assert.doesNotMatch(res.text, /正品查詢成功/);
  assert.match(res.text, /href="tel:0287578588"/);
  assert.doesNotMatch(res.text, /name="checkcode"/);
});

test('關閉驗證碼：POST /verify 回 404 且不寫入事件', async () => {
  const { app, db } = setup(OFF);
  const { label } = seedLabel(db);
  await request(app)
    .post('/verify')
    .type('form')
    .send({ product: 'A12B3C', code: label.code, checkcode: label.checkcode })
    .expect(404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.equal(db.prepare('SELECT verify_count FROM labels WHERE id = ?').get(label.id).verify_count, 0);
});

test('關閉驗證碼：測試卡不印驗證碼', async () => {
  const { app, db } = setup(OFF);
  const { batchId, label } = seedLabel(db);
  const cards = await request(app).get(`/admin/batches/${batchId}/cards`).set('Authorization', AUTH).expect(200);
  assert.doesNotMatch(cards.text, /驗證碼/);
  assert.ok(!cards.text.includes(label.checkcode));
});

test('關閉驗證碼：Excel 只有 sn / id / qrcodedata 三欄', async () => {
  const { app, db, config } = setup(OFF);
  const { batchId, label } = seedLabel(db, { quantity: 3 });
  const res = await request(app)
    .get(`/admin/batches/${batchId}/excel`)
    .set('Authorization', AUTH)
    .buffer(true)
    .parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body);
  const sheet = wb.getWorksheet('labels');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['sn', 'id', 'qrcodedata']);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['1', 'A12B3C', `${config.baseUrl}/A12B3C/${label.code}`]);
  assert.equal(sheet.columnCount, 3);
  const all = sheet.getSheetValues().flat().join(' ');
  assert.ok(!all.includes(label.checkcode), 'Excel 不可含驗證碼');
});

test('預設開啟驗證碼：維持原本流程', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  const res = await request(app).get(`/A12B3C/${label.code}`).expect(200);
  assert.match(res.text, /name="checkcode"/);
  assert.doesNotMatch(res.text, /正品查詢成功/);
});
