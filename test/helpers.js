'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDb } = require('../src/db');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const labels = require('../src/services/labels');

const TEST_ENV = {
  BASE_URL: 'HTTPS://Q.CO',
  ADMIN_USER: 'admin',
  ADMIN_PASS: 'test-password-123',
  IP_HASH_SALT: 'test-salt-0123456789',
  ADMIN_REQUIRE_HTTPS: 'false',
};

// 每次呼叫都是全新的記憶體資料庫、上傳資料夾與限流計數
function setup(envOverrides = {}) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-auth-test-'));
  test.after(() => fs.rmSync(uploadDir, { recursive: true, force: true }));
  const config = loadConfig({ ...TEST_ENV, UPLOAD_DIR: uploadDir, ...envOverrides });
  const db = openDb(':memory:');
  const app = createApp({ config, db });
  return { config, db, app };
}

// 建立產品與批次，回傳第一張標籤
function seedLabel(db, { productId = 'A12B3C', quantity = 1 } = {}) {
  if (!labels.getProduct(db, productId)) {
    labels.createProduct(db, { id: productId, name: '測試產品', description: '說明' });
  }
  const batchId = labels.createBatch(db, { productId, quantity });
  const label = db.prepare('SELECT * FROM labels WHERE batch_id = ? AND sn = 1').get(batchId);
  return { batchId, label };
}

const AUTH = 'Basic ' + Buffer.from(`${TEST_ENV.ADMIN_USER}:${TEST_ENV.ADMIN_PASS}`).toString('base64');

module.exports = { TEST_ENV, AUTH, setup, seedLabel };
