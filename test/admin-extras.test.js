'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const codes = require('../src/lib/codes');
const labels = require('../src/services/labels');
const { setup, seedLabel, AUTH } = require('./helpers');

const csrfOf = (html) => html.match(/name="_csrf" value="([0-9a-f]+)"/)[1];

async function csrf(app) {
  const res = await request(app).get('/admin/batches').set('Authorization', AUTH).expect(200);
  return csrfOf(res.text);
}

const post = (app, url, fields) => request(app).post(url).set('Authorization', AUTH).type('form').send(fields);

test('extractCode：接受 16 碼或整串網址', () => {
  const code = '7K3M9QXR2T8VWZ4N';
  assert.equal(codes.extractCode(code), code);
  assert.equal(codes.extractCode(code.toLowerCase()), code);
  assert.equal(codes.extractCode(`HTTPS://Q.CO/A12B3C/${code}`), code);
  assert.equal(codes.extractCode(`  https://q.co/a12b3c/${code.toLowerCase()}/  `), code);
  assert.equal(codes.extractCode(`https://q.co/A12B3C/${code}?utm=x#top`), code);
  assert.equal(codes.extractCode('https://q.co/A12B3C'), null);
  assert.equal(codes.extractCode(''), null);
});

test('標籤查詢：貼整串網址也能查到', async () => {
  const { app, db, config } = setup();
  const { label } = seedLabel(db);
  const url = encodeURIComponent(codes.buildQrData(config.baseUrl, 'A12B3C', label.code));
  const res = await request(app).get(`/admin/labels?code=${url}`).set('Authorization', AUTH).expect(200);
  assert.match(res.text, /#1 \/ 1/);
});

test('批次備註編輯', async () => {
  const { app, db } = setup();
  const { batchId } = seedLabel(db);
  const _csrf = await csrf(app);
  await post(app, `/admin/batches/${batchId}/note`, { _csrf, note: '  第一批印刷  ' }).expect(302);
  assert.equal(labels.getBatch(db, batchId).note, '第一批印刷');
  await post(app, `/admin/batches/${batchId}/note`, { _csrf, note: '' }).expect(302);
  assert.equal(labels.getBatch(db, batchId).note, null);
  await post(app, `/admin/batches/${batchId}/note`, { note: 'x' }).expect(403);
});

test('恢復作廢：批次', async () => {
  const { app, db } = setup();
  const { batchId, label } = seedLabel(db);
  const _csrf = await csrf(app);
  await post(app, `/admin/batches/${batchId}/void`, { _csrf }).expect(302);
  await request(app).get(`/A12B3C/${label.code}`).expect(410);
  const list = await request(app).get('/admin/batches').set('Authorization', AUTH);
  assert.match(list.text, /恢復啟用/);
  await post(app, `/admin/batches/${batchId}/restore`, { _csrf }).expect(302);
  await request(app).get(`/A12B3C/${label.code}`).expect(200);
});

test('恢復作廢：單張標籤，並寫入後台操作紀錄', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  const _csrf = await csrf(app);
  await post(app, `/admin/labels/${label.id}/void`, { _csrf }).expect(302);
  let page = await request(app).get(`/admin/labels?code=${label.code}`).set('Authorization', AUTH);
  assert.match(page.text, /恢復啟用此標籤/);
  await post(app, `/admin/labels/${label.id}/restore`, { _csrf }).expect(302);
  await request(app).get(`/A12B3C/${label.code}`).expect(200);

  const types = db.prepare('SELECT type FROM events WHERE label_id = ? ORDER BY id').pluck().all(label.id);
  assert.deepEqual(types, ['admin_void', 'admin_restore', 'scan']);
  page = await request(app).get(`/admin/labels?code=${label.code}`).set('Authorization', AUTH);
  assert.match(page.text, /🔧 後台作廢/);
  assert.match(page.text, /🔧 後台恢復/);
});

test('解鎖：失敗 10 次鎖定後，解鎖可再驗證', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  db.prepare('UPDATE labels SET fail_count = 10 WHERE id = ?').run(label.id);
  const verify = () =>
    request(app).post('/verify').type('form').send({ product: 'A12B3C', code: label.code, checkcode: label.checkcode });
  await verify().expect(423);

  let page = await request(app).get(`/admin/labels?code=${label.code}`).set('Authorization', AUTH);
  assert.match(page.text, /已鎖定/);
  assert.match(page.text, /解鎖（失敗次數歸零）/);
  await post(app, `/admin/labels/${label.id}/unlock`, { _csrf: csrfOf(page.text) }).expect(302);

  assert.equal(db.prepare('SELECT fail_count FROM labels WHERE id = ?').get(label.id).fail_count, 0);
  await verify().expect(200);
  page = await request(app).get(`/admin/labels?code=${label.code}`).set('Authorization', AUTH);
  assert.match(page.text, /🔧 後台解鎖/);
  assert.doesNotMatch(page.text, /已鎖定/);
});

test('測試卡：預設 24 張，可指定範圍，上限 300 張', async () => {
  const { app, db } = setup();
  const { batchId } = seedLabel(db, { quantity: 400 });
  const count = (html) => (html.match(/class="test-card"/g) || []).length;

  let res = await request(app).get(`/admin/batches/${batchId}/cards`).set('Authorization', AUTH).expect(200);
  assert.equal(count(res.text), 24);
  assert.match(res.text, /No\. 1</);
  assert.match(res.text, /<svg xmlns/);
  const first = db.prepare('SELECT checkcode FROM labels WHERE batch_id = ? AND sn = 1').get(batchId);
  assert.ok(res.text.includes(first.checkcode));

  res = await request(app).get(`/admin/batches/${batchId}/cards?from=5&to=7`).set('Authorization', AUTH);
  assert.equal(count(res.text), 3);
  assert.match(res.text, /No\. 5</);
  assert.match(res.text, /No\. 7</);

  res = await request(app).get(`/admin/batches/${batchId}/cards?from=1&to=400`).set('Authorization', AUTH);
  assert.equal(count(res.text), 300);

  res = await request(app).get(`/admin/batches/${batchId}/cards?from=390&to=9999`).set('Authorization', AUTH);
  assert.equal(count(res.text), 11);
});

test('測試卡需要登入', async () => {
  const { app, db } = setup();
  const { batchId } = seedLabel(db);
  await request(app).get(`/admin/batches/${batchId}/cards`).expect(401);
});
