'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const codes = require('../lib/codes');
const { hashIp, normalizeIp } = require('../lib/ip');
const labels = require('../services/labels');

function publicRouter({ config, db }) {
  const router = express.Router();

  const meta = (req) => ({
    ip: normalizeIp(req.ip),
    ipHash: hashIp(req.ip, config.ipHashSalt),
    userAgent: req.get('user-agent'),
  });

  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  const notFoundPage = (res) =>
    res.status(404).render('message', {
      title: '查無此標籤',
      message: '查無此標籤，可能為仿冒品。',
      tone: 'bad',
      showContact: true,
    });

  const voidPage = (res) =>
    res.status(410).render('message', {
      title: '標籤已作廢',
      message: '此標籤已作廢。',
      tone: 'bad',
      showContact: true,
    });

  const verifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).render('message', {
        title: '嘗試次數過多',
        message: '驗證次數過多，請 15 分鐘後再試。',
        tone: 'bad',
      }),
  });

  router.post('/verify', noStore, verifyLimiter, (req, res) => {
    const productId = codes.normalizeProductId(req.body.product);
    const code = codes.normalizeCode(req.body.code);
    if (!productId || !code) return notFoundPage(res);

    const result = labels.verify(db, {
      productId,
      code,
      checkcode: String(req.body.checkcode || ''),
      ...meta(req),
    });

    switch (result.status) {
      case 'not_found':
        return notFoundPage(res);
      case 'void':
        return voidPage(res);
      case 'locked':
        return res.status(423).render('message', {
          title: '已鎖定',
          message: '此標籤驗證失敗次數過多，已暫停驗證，請聯絡客服。',
          tone: 'bad',
          showContact: true,
        });
      case 'fail':
        return res.status(400).render('scan', {
          product: labels.getProduct(db, productId),
          label: null,
          productId,
          code,
          error: `驗證碼錯誤，還可以再試 ${result.remaining} 次。`,
        });
      default:
        return res.render('verify-result', { result });
    }
  });

  // 格式不符就交給後面的 404，不寫入事件
  router.get('/:product/:code', noStore, (req, res, next) => {
    const productId = codes.normalizeProductId(req.params.product);
    const code = codes.normalizeCode(req.params.code);
    if (!productId || !code) return next();

    const result = labels.recordScan(db, { productId, code, ...meta(req) });
    if (result.status === 'not_found') return notFoundPage(res);
    if (result.status === 'void') return voidPage(res);
    res.render('scan', { product: result.product, label: result.label, productId, code, error: null });
  });

  return router;
}

module.exports = publicRouter;
