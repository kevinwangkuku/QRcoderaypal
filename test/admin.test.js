'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, seedLabel, AUTH } = require('./helpers');

const csrfOf = (html) => html.match(/name="_csrf" value="([0-9a-f]+)"/)[1];

test('後台需要 Basic Auth', async () => {
  const { app } = setup();
  const res = await request(app).get('/admin/products').expect(401);
  assert.match(res.headers['www-authenticate'], /^Basic/);
  const bad = 'Basic ' + Buffer.from('admin:wrong-password').toString('base64');
  await request(app).get('/admin/products').set('Authorization', bad).expect(401);
  await request(app).get('/admin/products').set('Authorization', AUTH).expect(200);
});

test('登出：側邊欄有登出按鈕，/admin/logout 只接受假帳號 logout', async () => {
  const { app } = setup();
  const page = await request(app).get('/admin/products').set('Authorization', AUTH).expect(200);
  assert.match(page.text, /data-logout/);
  assert.match(page.text, /👤 admin/);

  const fake = 'Basic ' + Buffer.from('logout:logout').toString('base64');
  await request(app).get('/admin/logout').set('Authorization', fake).expect(200);
  // 真帳號或沒帶帳號都回 401，讓瀏覽器改用前端提供的假帳號
  const res = await request(app).get('/admin/logout').set('Authorization', AUTH).expect(401);
  assert.match(res.headers['www-authenticate'], /realm="admin"/);
  await request(app).get('/admin/logout').expect(401);
  // 假帳號不能進後台
  await request(app).get('/admin/products').set('Authorization', fake).expect(401);

  const out = await request(app).get('/logged-out').expect(200);
  assert.match(out.text, /已登出/);
});

test('ADMIN_USER 不可使用保留名稱 logout', () => {
  const { loadConfig } = require('../src/config');
  const { TEST_ENV } = require('./helpers');
  assert.throws(() => loadConfig({ ...TEST_ENV, ADMIN_USER: 'logout' }), /logout/);
});

test('ADMIN_REQUIRE_HTTPS=true 時 HTTP 請求被拒，經反向代理的 HTTPS 可用', async () => {
  const { app } = setup({ ADMIN_REQUIRE_HTTPS: 'true' });
  await request(app).get('/admin/products').set('Authorization', AUTH).expect(403);
  await request(app)
    .get('/admin/products')
    .set('Authorization', AUTH)
    .set('X-Forwarded-Proto', 'https')
    .expect(200);
});

test('POST 沒有 CSRF token 時拒絕', async () => {
  const { app, db } = setup();
  await request(app)
    .post('/admin/products')
    .set('Authorization', AUTH)
    .type('form')
    .send({ id: 'A12B3C', name: 'x' })
    .expect(403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0);
});

test('建立產品 → 預覽批次 → 建立批次 → 下載 Excel', async () => {
  const { app, db } = setup();
  const agent = request(app);
  const form = await agent.get('/admin/products/new').set('Authorization', AUTH).expect(200);
  const _csrf = csrfOf(form.text);

  await agent
    .post('/admin/products')
    .set('Authorization', AUTH)
    .type('form')
    .send({ _csrf, id: 'a12b3c', name: '測試產品', image_url: 'javascript:alert(1)' })
    .expect(400);
  await agent
    .post('/admin/products')
    .set('Authorization', AUTH)
    .type('form')
    .send({ _csrf, id: 'a12b3c', name: '測試產品' })
    .expect(302);
  assert.equal(db.prepare('SELECT id FROM products').get().id, 'A12B3C');

  const preview = await agent
    .post('/admin/batches/preview')
    .set('Authorization', AUTH)
    .type('form')
    .send({ _csrf, product_id: 'A12B3C', quantity: '10' })
    .expect(200);
  assert.match(preview.text, /HTTPS:\/\/Q\.CO\/A12B3C\/[0-9A-Z]{16}/);
  assert.match(preview.text, /36/);
  assert.match(preview.text, /Version 2（25×25 模組，M 級糾錯）/);
  assert.match(preview.text, /class="qr qr-7mm"><svg/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batches').get().n, 0, '預覽不可建立批次');

  await agent
    .post('/admin/batches')
    .set('Authorization', AUTH)
    .type('form')
    .send({ _csrf, product_id: 'A12B3C', quantity: '10' })
    .expect(302);
  const batch = db.prepare('SELECT * FROM batches').get();
  assert.equal(batch.quantity, 10);

  const xlsx = await agent
    .get(`/admin/batches/${batch.id}/excel`)
    .set('Authorization', AUTH)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200);
  assert.match(xlsx.headers['content-disposition'], new RegExp(`A12B3C_batch${batch.id}_\\d{8}\\.xlsx`));
  assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
});

test('預覽超過 QR_MAX_VERSION 時顯示警告', async () => {
  const { app, db } = setup({ BASE_URL: 'HTTPS://EXAMPLE.COM.TW', QR_MAX_VERSION: '2' });
  seedLabel(db);
  const form = await request(app).get('/admin/batches/new').set('Authorization', AUTH);
  const res = await request(app)
    .post('/admin/batches/preview')
    .set('Authorization', AUTH)
    .type('form')
    .send({ _csrf: csrfOf(form.text), product_id: 'A12B3C', quantity: '1' })
    .expect(200);
  assert.match(res.text, /超過上限 Version 2/);
});

test('標籤查詢與單張作廢', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  await request(app).get(`/A12B3C/${label.code}`).expect(200);

  const page = await request(app)
    .get(`/admin/labels?code=${label.code.toLowerCase()}`)
    .set('Authorization', AUTH)
    .expect(200);
  assert.match(page.text, /掃描<\/td>/);
  assert.match(page.text, /(127\.0\.0\.1|::1)/, '事件紀錄要顯示實際 IP');

  await request(app)
    .post(`/admin/labels/${label.id}/void`)
    .set('Authorization', AUTH)
    .type('form')
    .send({ _csrf: csrfOf(page.text) })
    .expect(302);
  await request(app).get(`/A12B3C/${label.code}`).expect(410);
});

test('可疑標籤依門檻篩選', async () => {
  const { app, db } = setup();
  const { label } = seedLabel(db);
  for (let i = 0; i < 3; i++) await request(app).get(`/A12B3C/${label.code}`);
  let res = await request(app).get('/admin/suspicious?min_scans=3').set('Authorization', AUTH).expect(200);
  assert.ok(res.text.includes(label.code));
  res = await request(app).get('/admin/suspicious?min_scans=4').set('Authorization', AUTH).expect(200);
  assert.ok(!res.text.includes(label.code));
});
