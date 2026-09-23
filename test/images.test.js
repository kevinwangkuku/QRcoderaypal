'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const images = require('../src/lib/images');
const { setup, AUTH } = require('./helpers');

// 1×1 透明 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

const csrfOf = (html) => html.match(/name="_csrf" value="([0-9a-f]+)"/)[1];

async function newForm(app) {
  const res = await request(app).get('/admin/products/new').set('Authorization', AUTH).expect(200);
  return csrfOf(res.text);
}

function postProduct(app, url, fields, file) {
  let req = request(app).post(url).set('Authorization', AUTH);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  if (file) req = req.attach('image', file.buf, file.name);
  return req;
}

test('依檔頭判斷圖片格式，不支援 SVG 與偽裝的檔案', () => {
  assert.equal(images.detectImageType(PNG), 'png');
  assert.equal(images.detectImageType(JPG), 'jpg');
  assert.equal(images.detectImageType(Buffer.from('GIF89a......')), 'gif');
  assert.equal(images.detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(images.detectImageType(SVG), null);
  assert.equal(images.detectImageType(Buffer.from('<html>not an image</html>')), null);
  assert.equal(images.detectImageType(Buffer.alloc(0)), null);
});

test('新增產品時上傳圖片：存檔、寫入 image_url，並可從 /uploads 讀取', async () => {
  const { app, db, config } = setup();
  const _csrf = await newForm(app);
  await postProduct(app, '/admin/products', { _csrf, id: 'A12B3C', name: '有圖' }, { buf: PNG, name: 'a.png' }).expect(302);

  const { image_url } = db.prepare('SELECT image_url FROM products').get();
  assert.match(image_url, /^\/uploads\/[0-9a-f]{24}\.png$/);
  assert.ok(fs.existsSync(path.join(config.uploadDir, path.basename(image_url))));

  const img = await request(app).get(image_url).expect(200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.deepEqual(img.body, PNG);
});

test('上傳非圖片或 SVG：拒絕且不存檔', async () => {
  const { app, db, config } = setup();
  const _csrf = await newForm(app);
  for (const file of [{ buf: SVG, name: 'x.svg' }, { buf: Buffer.from('hello'), name: 'fake.png' }]) {
    const res = await postProduct(app, '/admin/products', { _csrf, id: 'A12B3C', name: 'x' }, file).expect(400);
    assert.match(res.text, /只接受 JPG、PNG、WebP、GIF 圖片/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0);
  assert.deepEqual(fs.readdirSync(config.uploadDir), []);
});

test('上傳超過 2 MB：顯示錯誤', async () => {
  const { app, db } = setup();
  const _csrf = await newForm(app);
  const big = Buffer.concat([PNG, Buffer.alloc(images.MAX_IMAGE_BYTES)]);
  const res = await postProduct(app, '/admin/products', { _csrf, id: 'A12B3C', name: 'x' }, { buf: big, name: 'big.png' });
  assert.equal(res.status, 400);
  assert.match(res.text, /圖片不可超過 2 MB/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0);
});

test('上傳表單同樣需要 CSRF token', async () => {
  const { app, db } = setup();
  await postProduct(app, '/admin/products', { id: 'A12B3C', name: 'x' }, { buf: PNG, name: 'a.png' }).expect(403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0);
});

test('其他路由送 multipart 不能繞過 CSRF', async () => {
  const { app, db } = setup();
  db.prepare("INSERT INTO products VALUES ('A12B3C', 'x', NULL, NULL, '2026-01-01')").run();
  db.prepare("INSERT INTO batches (product_id, quantity, created_at) VALUES ('A12B3C', 1, '2026-01-01')").run();
  await request(app).post('/admin/batches/1/void').set('Authorization', AUTH).field('x', '1').expect(403);
  assert.equal(db.prepare('SELECT status FROM batches').get().status, 'active');
});

test('編輯產品：換圖刪舊檔、不填保留、勾選移除', async () => {
  const { app, db, config } = setup();
  const _csrf = await newForm(app);
  const url = '/admin/products/A12B3C';
  await postProduct(app, '/admin/products', { _csrf, id: 'A12B3C', name: 'x' }, { buf: PNG, name: 'a.png' }).expect(302);
  const first = db.prepare('SELECT image_url FROM products').get().image_url;

  // 不選檔案也不填網址 → 保留
  await postProduct(app, url, { _csrf, name: '改名' }).expect(302);
  assert.equal(db.prepare('SELECT image_url FROM products').get().image_url, first);

  // 換新圖 → 舊檔刪除
  await postProduct(app, url, { _csrf, name: '改名' }, { buf: JPG, name: 'b.jpg' }).expect(302);
  const second = db.prepare('SELECT image_url FROM products').get().image_url;
  assert.match(second, /\.jpg$/);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fs.readdirSync(config.uploadDir), [path.basename(second)]);

  // 勾選移除
  await postProduct(app, url, { _csrf, name: '改名', remove_image: '1' }).expect(302);
  assert.equal(db.prepare('SELECT image_url FROM products').get().image_url, null);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fs.readdirSync(config.uploadDir), []);
});

test('後台載入 admin.js 且 CSP 只允許本站 script；消費者頁面不載入 script', async () => {
  const { app } = setup();
  const form = await request(app).get('/admin/products/new').set('Authorization', AUTH).expect(200);
  assert.match(form.text, /<script src="\/admin\.js" defer><\/script>/);
  assert.match(form.text, /data-image-zone/);
  assert.match(form.headers['content-security-policy'], /script-src 'self';/);
  await request(app).get('/admin.js').expect(200).expect('Content-Type', /javascript/);

  const page = await request(app).get('/A12B3C/0000000000000000');
  assert.doesNotMatch(page.text, /<script/);
});

test('仍可使用外部圖片網址', async () => {
  const { app, db } = setup();
  const _csrf = await newForm(app);
  await postProduct(app, '/admin/products', { _csrf, id: 'A12B3C', name: 'x', image_url: 'https://example.com/a.png' }).expect(302);
  assert.equal(db.prepare('SELECT image_url FROM products').get().image_url, 'https://example.com/a.png');
});
