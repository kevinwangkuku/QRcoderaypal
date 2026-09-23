'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { formatTime } = require('./lib/time');
const adminRouter = require('./routes/admin');
const publicRouter = require('./routes/public');

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      // script 只允許本站檔案（後台的 admin.js）；blob: 用於貼上圖片後的預覽
      "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
}

function createApp({ config, db }) {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');

  app.locals.fmt = (iso) => formatTime(iso, config.tz);

  app.use(securityHeaders);
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
  // 產品圖片；檔名隨機且不會覆寫，可長期快取
  fs.mkdirSync(config.uploadDir, { recursive: true });
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '30d', immutable: true, index: false }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  // 順序重要：/admin、/verify 必須排在 /:product/:code 前面
  app.use('/admin', adminRouter({ config, db }));
  // 放在 /admin 之外：若在 /admin 底下，瀏覽器會帶著登出用的假帳號而立刻跳出登入視窗
  app.get('/logged-out', (req, res) => res.render('logged-out'));
  app.use('/', publicRouter({ config, db }));

  app.use((req, res) => {
    res.status(404).render('message', { title: '找不到頁面', message: '找不到這個頁面。', tone: 'bad' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return res.destroy();
    res.status(500).render('message', { title: '系統錯誤', message: '系統發生錯誤，請稍後再試。', tone: 'bad' });
  });

  return app;
}

module.exports = { createApp };
