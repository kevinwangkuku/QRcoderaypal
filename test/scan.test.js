'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const labels = require('../src/services/labels');
const { setup, seedLabel } = require('./helpers');

const eventsOf = (db, type) => db.prepare('SELECT * FROM events WHERE type = ?').all(type);

test('掃描正確碼：顯示產品與查詢次數，scan_count +1 並記錄 scan', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);

  const res = await request(app).get(`/A12B3C/${label.code}`).expect(200);
  assert.match(res.text, /測試產品/);
  assert.match(res.text, /1 次/);
  assert.match(res.text, /name="checkcode"/);
  assert.ok(!res.text.includes(label.checkcode), 'checkcode 不可出現在頁面上');

  await request(app).get(`/A12B3C/${label.code}`).expect(200);
  const after = db.prepare('SELECT * FROM labels WHERE id = ?').get(label.id);
  assert.equal(after.scan_count, 2);
  assert.ok(after.first_scan_at);
  const scans = eventsOf(db, 'scan');
  assert.equal(scans.length, 2);
  assert.match(scans[0].ip_hash, /^[0-9a-f]{64}$/);
  assert.match(scans[0].ip, /^(127\.0\.0\.1|::1)$/);
  assert.match(res.text, /會記錄查詢時的 IP 位址/);
});

test('經反向代理時記錄 X-Forwarded-For 的實際 IP', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  await request(app).get(`/A12B3C/${label.code}`).set('X-Forwarded-For', '203.0.113.7').expect(200);
  assert.equal(eventsOf(db, 'scan')[0].ip, '203.0.113.7');
});

test('IPv4-mapped IPv6 轉成一般寫法', () => {
  const { normalizeIp } = require('../src/lib/ip');
  assert.equal(normalizeIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeIp(undefined), null);
});

test('掃描錯誤碼：顯示查無此標籤並記錄 not_found', async () => {
  const { app, db } = setup();
  seedLabel(db);
  const res = await request(app).get('/A12B3C/0000000000000000').expect(404);
  assert.match(res.text, /查無此標籤，可能為仿冒品/);
  const events = eventsOf(db, 'not_found');
  assert.equal(events.length, 1);
  assert.equal(events[0].label_id, null);
});

test('產品碼與變動碼不相符：視同查無此標籤', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  labels.createProduct(db, { id: 'ZZZZZZ', name: '另一個產品' });
  const res = await request(app).get(`/ZZZZZZ/${label.code}`).expect(404);
  assert.match(res.text, /查無此標籤/);
  assert.equal(db.prepare('SELECT scan_count FROM labels WHERE id = ?').get(label.id).scan_count, 0);
  assert.equal(eventsOf(db, 'not_found').length, 1);
});

test('作廢標籤與作廢批次：顯示此標籤已作廢', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  labels.voidLabel(db, label.id);
  let res = await request(app).get(`/A12B3C/${label.code}`).expect(410);
  assert.match(res.text, /此標籤已作廢/);

  const { batchId, label: other } = seedLabel(db);
  labels.voidBatch(db, batchId);
  res = await request(app).get(`/A12B3C/${other.code}`).expect(410);
  assert.match(res.text, /此標籤已作廢/);
});

test('大小寫混用：轉大寫後正常查詢', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  const mixed = label.code.toLowerCase().replace(/^(.{4})/, (s) => s.toUpperCase());
  const res = await request(app).get(`/a12B3c/${mixed}`).expect(200);
  assert.match(res.text, /測試產品/);
  assert.match(res.text, new RegExp(`value="${label.code}"`));
});

test('格式不符的路徑直接 404，不寫入事件', async () => {
  const { app, db } = setup();
  seedLabel(db);
  await request(app).get('/A12B3C/SHORT').expect(404);
  await request(app).get('/A12B3/0000000000000000').expect(404);
  await request(app).get('/A12B3C/000000000000000U').expect(404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});
