'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, seedLabel } = require('./helpers');

const post = (app, label, checkcode) =>
  request(app).post('/verify').type('form').send({ product: 'A12B3C', code: label.code, checkcode });

test('首次驗證成功', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  const res = await post(app, label, label.checkcode).expect(200);
  assert.match(res.text, /✅ 正品驗證成功/);
  const after = db.prepare('SELECT * FROM labels WHERE id = ?').get(label.id);
  assert.equal(after.verify_count, 1);
  assert.ok(after.first_verify_at);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'verify_ok'").get().n, 1);
});

test('重複驗證成功：顯示首次驗證時間與次數', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  await post(app, label, label.checkcode).expect(200);
  const res = await post(app, label, label.checkcode.toLowerCase()).expect(200);
  assert.match(res.text, /⚠️/);
  assert.match(res.text, /此標籤已於 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 驗證過，共 2 次/);
  assert.match(res.text, /可能是複製標籤的仿冒品/);
});

test('驗證失敗：顯示驗證碼錯誤與剩餘次數', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  const wrong = label.checkcode === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
  const res = await post(app, label, wrong).expect(400);
  assert.match(res.text, /驗證碼錯誤，還可以再試 9 次/);
  const after = db.prepare('SELECT * FROM labels WHERE id = ?').get(label.id);
  assert.equal(after.fail_count, 1);
  assert.equal(after.verify_count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'verify_fail'").get().n, 1);
});

test('失敗達 10 次後鎖定，之後輸入正確碼也顯示請聯絡客服', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  const wrong = label.checkcode === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
  for (let i = 1; i <= 9; i++) {
    const res = await post(app, label, wrong).expect(400);
    assert.match(res.text, new RegExp(`還可以再試 ${10 - i} 次`));
  }
  let res = await post(app, label, wrong).expect(423);
  assert.match(res.text, /請聯絡客服/);
  res = await post(app, label, label.checkcode).expect(423);
  assert.match(res.text, /請聯絡客服/);
  const after = db.prepare('SELECT * FROM labels WHERE id = ?').get(label.id);
  assert.equal(after.fail_count, 10);
  assert.equal(after.verify_count, 0);
});

test('驗證不存在或產品碼不符的標籤：查無此標籤', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  let res = await request(app)
    .post('/verify')
    .type('form')
    .send({ product: 'ZZZZZZ', code: label.code, checkcode: label.checkcode })
    .expect(404);
  assert.match(res.text, /查無此標籤/);
  res = await request(app)
    .post('/verify')
    .type('form')
    .send({ product: 'A12B3C', code: 'bad', checkcode: 'X' })
    .expect(404);
  assert.match(res.text, /查無此標籤/);
});

test('限流：同一 IP 15 分鐘內第 21 次回應 429', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db, { quantity: 3 });
  const others = db.prepare('SELECT * FROM labels ORDER BY sn').all();
  // 分散在不同標籤，避免先觸發 10 次鎖定
  for (let i = 0; i < 20; i++) {
    await post(app, others[i % 3], label.checkcode + 'X').expect((r) => assert.notEqual(r.status, 429));
  }
  const res = await post(app, label, label.checkcode).expect(429);
  assert.match(res.text, /驗證次數過多/);
});
