'use strict';

const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const codes = require('../lib/codes');
const images = require('../lib/images');
const { hashIp, normalizeIp } = require('../lib/ip');
const qr = require('../lib/qr');
const { dateStamp } = require('../lib/time');
const { writeExcel, writeSvgZip } = require('../lib/export');
const labels = require('../services/labels');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest();
}

function requireHttps(config) {
  return (req, res, next) => {
    if (!config.adminRequireHttps || req.secure) return next();
    res.status(403).render('message', { title: '需要 HTTPS', message: '後台只能透過 HTTPS 使用。', tone: 'bad' });
  };
}

function basicAuth(config) {
  const expectedUser = sha256(config.adminUser);
  const expectedPass = sha256(config.adminPass);
  return (req, res, next) => {
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i >= 0) {
        // 帳號與密碼都比對完才判斷，避免時間差洩漏哪一個錯
        const userOk = crypto.timingSafeEqual(sha256(decoded.slice(0, i)), expectedUser);
        const passOk = crypto.timingSafeEqual(sha256(decoded.slice(i + 1)), expectedPass);
        if (userOk && passOk) return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="admin", charset="UTF-8"');
    res.status(401).send('需要登入');
  };
}

// Basic Auth 會被瀏覽器自動帶上，所以所有 POST 都要檢查表單裡的 token。
// multipart 表單要等 multer 解析完才讀得到 token，由路由自行接上 csrf.verify。
// 只有產品表單可以延後檢查；其他路由送 multipart 一律照常驗證（讀不到 token 就拒絕）。
const MULTIPART_PATHS = /^\/products(\/[^/]+)?$/;

// 登出用的假帳號；設定檢查會禁止 ADMIN_USER 使用這個名稱
const LOGOUT_USER = 'logout';

function csrf() {
  const token = crypto.randomBytes(24).toString('hex');
  const expected = Buffer.from(token);
  const verify = (req, res, next) => {
    const got = Buffer.from(String((req.body && req.body._csrf) || ''));
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return next();
    res.status(403).render('message', {
      title: '頁面已過期',
      message: '表單已過期，請回上一頁重新整理後再送出。',
      tone: 'bad',
    });
  };
  const middleware = (req, res, next) => {
    res.locals.csrfToken = token;
    if (req.method !== 'POST') return next();
    if (req.is('multipart/form-data') && MULTIPART_PATHS.test(req.path)) return next();
    verify(req, res, next);
  };
  return { middleware, verify };
}

// 解析產品表單的圖片欄位；檔案過大等錯誤記在 req.uploadError，由路由顯示在表單上
function imageUpload() {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: images.MAX_IMAGE_BYTES, files: 1, fields: 20 },
  }).single('image');
  return (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    upload(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? '圖片不可超過 2 MB' : '圖片上傳失敗，請重試';
        return next();
      }
      next(err);
    });
  };
}

function parseProductForm(body) {
  const form = {
    name: String(body.name || '').trim(),
    description: String(body.description || '').trim(),
    imageUrl: String(body.image_url || '').trim(),
  };
  const errors = [];
  if (!form.name) errors.push('請輸入產品名稱');
  if (form.name.length > 200) errors.push('產品名稱過長');
  if (form.description.length > 5000) errors.push('說明過長');
  if (form.imageUrl && !/^https?:\/\/\S+$/i.test(form.imageUrl)) errors.push('圖片網址必須以 http:// 或 https:// 開頭');
  return { form, errors };
}

function parseBatchForm(body) {
  const form = {
    productId: codes.normalizeProductId(String(body.product_id || '')),
    quantity: Number(body.quantity),
    note: String(body.note || '').trim().slice(0, 500),
  };
  const errors = [];
  if (!form.productId) errors.push('請選擇產品');
  if (!Number.isInteger(form.quantity) || form.quantity < 1 || form.quantity > labels.MAX_BATCH_QUANTITY) {
    errors.push(`數量必須是 1 到 ${labels.MAX_BATCH_QUANTITY.toLocaleString()} 的整數`);
  }
  return { form, errors };
}

function adminRouter({ config, db }) {
  const router = express.Router();
  const csrfGuard = csrf();
  const productForm = [imageUpload(), csrfGuard.verify];
  router.use(requireHttps(config));

  // Basic Auth 沒有標準登出：前端用假帳號 logout 請求這裡，伺服器回 200，
  // 瀏覽器就會以假帳號覆蓋記住的真帳號，之後進後台需重新登入。
  router.get('/logout', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    const user = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8').split(':')[0] : '';
    if (user === LOGOUT_USER) return res.send('ok');
    res.set('WWW-Authenticate', 'Basic realm="admin", charset="UTF-8"');
    res.status(401).send('');
  });

  router.use(basicAuth(config), csrfGuard.middleware);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.locals.admin = true;
    res.locals.adminUser = config.adminUser;
    res.locals.nav = req.path.split('/')[1] || '';
    next();
  });

  const loadBatch = (req, res) => {
    const batch = /^\d+$/.test(req.params.id) ? labels.getBatch(db, Number(req.params.id)) : null;
    if (!batch) res.status(404).render('message', { title: '找不到批次', message: '找不到這個批次。', tone: 'bad' });
    return batch;
  };

  router.get('/', (req, res) => res.redirect('/admin/batches'));

  // ---------- 產品 ----------

  router.get('/products', (req, res) => {
    res.render('admin/products', { products: labels.listProducts(db) });
  });

  router.get('/products/new', (req, res) => {
    res.render('admin/product-form', { product: null, form: {}, errors: [] });
  });

  // 決定產品最後的圖片：上傳檔 > 勾選移除 > 網址欄 > 保留原本上傳的圖
  // 回傳 { imageUrl, error }；成功時上傳檔已寫入磁碟
  const resolveImage = (req, form, current) => {
    if (req.uploadError) return { error: req.uploadError };
    if (req.file && req.file.size > 0) {
      const saved = images.saveImage(config.uploadDir, req.file.buffer);
      return saved ? { imageUrl: saved } : { error: '只接受 JPG、PNG、WebP、GIF 圖片' };
    }
    if (req.body.remove_image) return { imageUrl: null };
    if (form.imageUrl) return { imageUrl: form.imageUrl };
    return { imageUrl: images.isUploaded(current) ? current : null };
  };

  const renderProductForm = (res, product, form, errors) =>
    res.status(400).render('admin/product-form', { product, form, errors });

  router.post('/products', productForm, (req, res) => {
    const { form, errors } = parseProductForm(req.body);
    const id = String(req.body.id || '').trim().toUpperCase();
    form.id = id;
    if (!codes.PRODUCT_ID_RE.test(id)) errors.unshift('產品碼必須是 6 個英數字元（0-9、A-Z）');
    else if (labels.getProduct(db, id)) errors.unshift(`產品碼 ${id} 已存在`);
    if (req.uploadError) errors.push(req.uploadError);
    if (errors.length) return renderProductForm(res, null, form, errors);

    const image = resolveImage(req, form, null);
    if (image.error) return renderProductForm(res, null, form, [image.error]);
    labels.createProduct(db, { ...form, imageUrl: image.imageUrl });
    res.redirect('/admin/products');
  });

  router.get('/products/:id/edit', (req, res, next) => {
    const product = labels.getProduct(db, req.params.id);
    if (!product) return next();
    const form = {
      name: product.name,
      description: product.description || '',
      // 上傳的圖片以預覽顯示，網址欄只放外部網址
      imageUrl: images.isUploaded(product.image_url) ? '' : product.image_url || '',
    };
    res.render('admin/product-form', { product, form, errors: [] });
  });

  router.post('/products/:id', productForm, (req, res, next) => {
    const product = labels.getProduct(db, req.params.id);
    if (!product) return next();
    const { form, errors } = parseProductForm(req.body);
    if (req.uploadError) errors.push(req.uploadError);
    if (errors.length) return renderProductForm(res, product, form, errors);

    const image = resolveImage(req, form, product.image_url);
    if (image.error) return renderProductForm(res, product, form, [image.error]);
    labels.updateProduct(db, product.id, { ...form, imageUrl: image.imageUrl });
    if (product.image_url !== image.imageUrl) images.deleteImage(config.uploadDir, product.image_url);
    res.redirect('/admin/products');
  });

  // ---------- 批次 ----------

  router.get('/batches', (req, res) => {
    const batches = labels.listBatches(db);
    // 剛建立完成：頁面上方顯示下載按鈕，提醒把 Excel 交給條碼程式
    const created = batches.find((b) => String(b.id) === req.query.created) || null;
    res.render('admin/batches', { batches, created });
  });

  router.get('/batches/new', (req, res) => {
    res.render('admin/batch-form', {
      products: labels.listProducts(db),
      form: { productId: req.query.product || '', quantity: '', note: '' },
      errors: [],
    });
  });

  // 建立前預覽：範例 qrcodedata、QR 版本、實際 7 mm 大小
  router.post('/batches/preview', (req, res) => {
    const { form, errors } = parseBatchForm(req.body);
    const product = form.productId && labels.getProduct(db, form.productId);
    if (form.productId && !product) errors.push('找不到此產品');
    if (errors.length) {
      return res.status(400).render('admin/batch-form', { products: labels.listProducts(db), form, errors });
    }
    const sampleData = codes.buildQrData(config.baseUrl, product.id, codes.generateCode());
    const info = qr.analyze(sampleData, config.qrEcLevel);
    res.render('admin/batch-preview', {
      form,
      product,
      sampleData,
      info,
      ecLevel: config.qrEcLevel,
      maxVersion: config.qrMaxVersion,
      svg: qr.toSvg(sampleData, { ecLevel: config.qrEcLevel, margin: config.qrMargin }),
    });
  });

  router.post('/batches', (req, res) => {
    const { form, errors } = parseBatchForm(req.body);
    if (!errors.length && !labels.getProduct(db, form.productId)) errors.push('找不到此產品');
    if (errors.length) {
      return res.status(400).render('admin/batch-form', { products: labels.listProducts(db), form, errors });
    }
    const batchId = labels.createBatch(db, form);
    res.redirect(`/admin/batches?created=${batchId}`);
  });

  router.get('/batches/:id/excel', async (req, res, next) => {
    const batch = loadBatch(req, res);
    if (!batch) return;
    const filename = `${batch.product_id}_batch${batch.id}_${dateStamp(new Date(), config.tz)}.xlsx`;
    res.attachment(filename);
    try {
      await writeExcel(res, labels.iterateBatchLabels(db, batch.id), { baseUrl: config.baseUrl });
    } catch (err) {
      next(err);
    }
  });

  router.get('/batches/:id/svg.zip', async (req, res, next) => {
    const batch = loadBatch(req, res);
    if (!batch) return;
    res.attachment(`${batch.product_id}_batch${batch.id}_svg.zip`);
    try {
      await writeSvgZip(res, labels.iterateBatchLabels(db, batch.id), {
        baseUrl: config.baseUrl,
        ecLevel: config.qrEcLevel,
        margin: config.qrMargin,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/batches/:id/void', (req, res) => {
    const batch = loadBatch(req, res);
    if (!batch) return;
    labels.voidBatch(db, batch.id);
    res.redirect('/admin/batches');
  });

  router.post('/batches/:id/restore', (req, res) => {
    const batch = loadBatch(req, res);
    if (!batch) return;
    labels.restoreBatch(db, batch.id);
    res.redirect('/admin/batches');
  });

  router.post('/batches/:id/note', (req, res) => {
    const batch = loadBatch(req, res);
    if (!batch) return;
    labels.updateBatchNote(db, batch.id, String(req.body.note || '').trim().slice(0, 500));
    res.redirect('/admin/batches');
  });

  // 測試卡：A4 排版，每張含 QR、編號、驗證碼；一次最多 MAX_CARDS 張
  const MAX_CARDS = 300;
  router.get('/batches/:id/cards', (req, res) => {
    const batch = loadBatch(req, res);
    if (!batch) return;
    const int = (raw, fallback) => {
      const n = Number(raw);
      return Number.isInteger(n) && n >= 1 ? n : fallback;
    };
    const from = Math.min(int(req.query.from, 1), batch.quantity);
    const to = Math.min(int(req.query.to, from + 23), batch.quantity, from + MAX_CARDS - 1);
    const cards = labels.listBatchLabelsRange(db, batch.id, from, Math.max(from, to)).map((l) => ({
      ...l,
      svg: qr.toSvg(codes.buildQrData(config.baseUrl, l.product_id, l.code), {
        ecLevel: config.qrEcLevel,
        margin: config.qrMargin,
      }),
    }));
    res.render('admin/cards', { batch, cards, from, to: Math.max(from, to), maxCards: MAX_CARDS });
  });

  // ---------- 標籤查詢 ----------

  router.get('/labels', (req, res) => {
    const query = String(req.query.code || '').trim();
    const code = query ? codes.extractCode(query) : null;
    const label = code ? labels.findLabelByCode(db, code) : null;
    res.render('admin/label', {
      query,
      label,
      maxFails: labels.MAX_VERIFY_FAILS,
      events: label ? labels.listLabelEvents(db, label.id) : [],
      qrData: label ? codes.buildQrData(config.baseUrl, label.product_id, label.code) : null,
    });
  });

  // 單張標籤操作：作廢、恢復、解鎖；完成後回到該標籤的查詢頁
  const labelAction = (action) => (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const id = Number(req.params.id);
    const label = db.prepare('SELECT code FROM labels WHERE id = ?').get(id);
    if (!label) return next();
    action(db, id, {
      ip: normalizeIp(req.ip),
      ipHash: hashIp(req.ip, config.ipHashSalt),
      userAgent: req.get('user-agent'),
    });
    res.redirect(`/admin/labels?code=${label.code}`);
  };

  router.post('/labels/:id/void', labelAction(labels.voidLabel));
  router.post('/labels/:id/restore', labelAction(labels.restoreLabel));
  router.post('/labels/:id/unlock', labelAction(labels.unlockLabel));

  // ---------- 可疑標籤 ----------

  router.get('/suspicious', (req, res) => {
    const threshold = (raw, fallback) => {
      const n = Number(raw);
      return Number.isInteger(n) && n >= 1 ? n : fallback;
    };
    const minScans = threshold(req.query.min_scans, 10);
    const minVerifies = threshold(req.query.min_verifies, 2);
    res.render('admin/suspicious', {
      minScans,
      minVerifies,
      rows: labels.listSuspicious(db, { minScans, minVerifies }),
    });
  });

  return router;
}

module.exports = adminRouter;
