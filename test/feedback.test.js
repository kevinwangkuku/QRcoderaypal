'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { setup, seedLabel, AUTH, TEST_ENV } = require('./helpers');

const CONTACT = {
  CONTACT_NAME: '範例公司',
  CONTACT_PHONE: '02-1234-5678',
  CONTACT_EMAIL: 'service@example.com',
  CONTACT_URL: 'https://line.me/R/ti/p/@example',
  CONTACT_URL_LABEL: 'LINE 客服',
};

test('第一次查詢不顯示重複提醒，第二次起顯示並附聯絡方式', async () => {
  const { app, db } = setup(CONTACT);
  const { label } = seedLabel(db);

  const first = await request(app).get(`/A12B3C/${label.code}`).expect(200);
  assert.doesNotMatch(first.text, /已被查詢過/);

  const second = await request(app).get(`/A12B3C/${label.code}`).expect(200);
  assert.match(second.text, /⚠️ 此防偽碼已被查詢過/);
  assert.match(second.text, /這是第 <strong>2<\/strong> 次查詢/);
  assert.match(second.text, /請聯繫 範例公司 協助確認/);
  assert.match(second.text, /href="tel:0212345678"/);
  assert.match(second.text, /href="mailto:service@example\.com"/);
  assert.match(second.text, /href="https:\/\/line\.me\/R\/ti\/p\/@example"[^>]*>LINE 客服</);
  // 仍可繼續驗證
  assert.match(second.text, /name="checkcode"/);
});

test('重複驗證、查無此標籤、已作廢都附聯絡方式', async () => {
  const { app, db } = setup(CONTACT);
  const { label } = seedLabel(db);
  const verify = () =>
    request(app).post('/verify').type('form').send({ product: 'A12B3C', code: label.code, checkcode: label.checkcode });

  const ok = await verify().expect(200);
  assert.doesNotMatch(ok.text, /請聯繫/);
  const repeat = await verify().expect(200);
  assert.match(repeat.text, /請聯繫 範例公司 協助確認/);

  const missing = await request(app).get('/A12B3C/0000000000000000').expect(404);
  assert.match(missing.text, /請聯繫 範例公司 協助確認/);
});

test('未設定聯絡資訊時顯示通用文字，不出現空的按鈕', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  await request(app).get(`/A12B3C/${label.code}`);
  const res = await request(app).get(`/A12B3C/${label.code}`).expect(200);
  assert.match(res.text, /請聯繫我們協助確認/);
  assert.doesNotMatch(res.text, /contact-links/);
});

test('CONTACT_URL 必須是 http(s) 網址', () => {
  assert.throws(() => loadConfig({ ...TEST_ENV, CONTACT_URL: 'javascript:alert(1)' }), /CONTACT_URL/);
});

test('建立批次後顯示下載 Excel 的按鈕', async () => {
  const { app, db } = setup();
  seedLabel(db); // 建立產品
  const form = await request(app).get('/admin/batches/new').set('Authorization', AUTH);
  const _csrf = form.text.match(/name="_csrf" value="([0-9a-f]+)"/)[1];
  const res = await request(app)
    .post('/admin/batches')
    .set('Authorization', AUTH)
    .type('form')
    .send({ _csrf, product_id: 'A12B3C', quantity: '5' })
    .expect(302);
  assert.match(res.headers.location, /^\/admin\/batches\?created=\d+$/);

  const page = await request(app).get(res.headers.location).set('Authorization', AUTH).expect(200);
  const id = res.headers.location.split('=')[1];
  assert.match(page.text, new RegExp(`✅ 批次 #${id} 已建立`));
  assert.match(page.text, new RegExp(`href="/admin/batches/${id}/excel">⬇ 下載 Excel`));

  const plain = await request(app).get('/admin/batches').set('Authorization', AUTH);
  assert.doesNotMatch(plain.text, /已建立/);
});
