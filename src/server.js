'use strict';

require('dotenv').config({ quiet: true });

const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { buildQrData, generateCode } = require('./lib/codes');
const { analyze } = require('./lib/qr');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`設定錯誤，拒絕啟動：${err.message}`);
  process.exit(1);
}

const sample = analyze(buildQrData(config.baseUrl, 'A12B3C', generateCode()), config.qrEcLevel);
if (sample.version > config.qrMaxVersion) {
  console.warn(
    `警告：qrcodedata ${sample.length} 字元在 ${config.qrEcLevel} 級糾錯下為 Version ${sample.version}，超過 QR_MAX_VERSION=${config.qrMaxVersion}`,
  );
}
if (!config.adminRequireHttps) {
  console.warn('警告：ADMIN_REQUIRE_HTTPS=false，後台可透過 HTTP 存取；正式環境請勿使用');
}

const db = openDb(config.dbPath);
const server = createApp({ config, db }).listen(config.port, () => {
  console.log(`QR 防偽標籤系統已啟動：http://localhost:${config.port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
