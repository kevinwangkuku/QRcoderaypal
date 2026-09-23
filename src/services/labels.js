'use strict';

const codes = require('../lib/codes');
const { nowIso } = require('../lib/time');

const MAX_BATCH_QUANTITY = 100000;
const MAX_VERIFY_FAILS = 10;
const MAX_CODE_RETRIES = 10;

// ---------- 產品 ----------

function listProducts(db) {
  return db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
}

function getProduct(db, id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

function createProduct(db, { id, name, description, imageUrl }) {
  db.prepare(
    'INSERT INTO products (id, name, description, image_url, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, name, description || null, imageUrl || null, nowIso());
}

// 產品碼不可修改，只更新其他欄位
function updateProduct(db, id, { name, description, imageUrl }) {
  return db
    .prepare('UPDATE products SET name = ?, description = ?, image_url = ? WHERE id = ?')
    .run(name, description || null, imageUrl || null, id).changes;
}

// ---------- 批次 ----------

// 在單一 transaction 內建立批次與全部標籤，回傳批次 id
function createBatch(db, { productId, quantity, note }) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BATCH_QUANTITY) {
    throw new RangeError(`數量必須介於 1 到 ${MAX_BATCH_QUANTITY}`);
  }
  const insertBatch = db.prepare(
    'INSERT INTO batches (product_id, quantity, note, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertLabel = db.prepare(
    'INSERT INTO labels (batch_id, product_id, sn, code, checkcode, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );

  return db.transaction(() => {
    const createdAt = nowIso();
    const batchId = insertBatch.run(productId, quantity, note || null, createdAt).lastInsertRowid;
    for (let sn = 1; sn <= quantity; sn++) {
      for (let attempt = 1; ; attempt++) {
        try {
          insertLabel.run(batchId, productId, sn, codes.generateCode(), codes.generateCheckcode(), createdAt);
          break;
        } catch (err) {
          // 變動碼碰撞（機率約 2^-80）就換一組重試
          const collided = err.code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message.includes('labels.code');
          if (!collided || attempt >= MAX_CODE_RETRIES) throw err;
        }
      }
    }
    return Number(batchId);
  })();
}

function getBatch(db, id) {
  return db
    .prepare(
      `SELECT b.*, p.name AS product_name
       FROM batches b JOIN products p ON p.id = b.product_id
       WHERE b.id = ?`,
    )
    .get(id);
}

function listBatches(db) {
  return db
    .prepare(
      `SELECT b.*, p.name AS product_name,
              (SELECT COUNT(*) FROM labels l WHERE l.batch_id = b.id AND l.scan_count > 0) AS scanned,
              (SELECT COUNT(*) FROM labels l WHERE l.batch_id = b.id AND l.verify_count > 0) AS verified
       FROM batches b JOIN products p ON p.id = b.product_id
       ORDER BY b.id DESC`,
    )
    .all();
}

function voidBatch(db, id) {
  return db.prepare("UPDATE batches SET status = 'void' WHERE id = ?").run(id).changes;
}

// 依 sn 順序分頁讀取，匯出大批次時不必一次載入記憶體。
// 不用 stmt.iterate()：遊標開著時連線會被佔住，匯出途中 await 會讓其他請求無法查詢。
function* iterateBatchLabels(db, batchId, pageSize = 2000) {
  const page = db.prepare(
    'SELECT sn, product_id, code, checkcode FROM labels WHERE batch_id = ? AND sn > ? ORDER BY sn LIMIT ?',
  );
  let lastSn = 0;
  for (;;) {
    const rows = page.all(batchId, lastSn, pageSize);
    yield* rows;
    if (rows.length < pageSize) return;
    lastSn = rows[rows.length - 1].sn;
  }
}

// ---------- 標籤 ----------

function findLabelByCode(db, code) {
  return db
    .prepare(
      `SELECT l.*, b.status AS batch_status, p.name AS product_name
       FROM labels l
       JOIN batches b ON b.id = l.batch_id
       JOIN products p ON p.id = l.product_id
       WHERE l.code = ?`,
    )
    .get(code);
}

function listLabelEvents(db, labelId) {
  return db.prepare('SELECT * FROM events WHERE label_id = ? ORDER BY id DESC').all(labelId);
}

function voidLabel(db, id) {
  return db.prepare("UPDATE labels SET status = 'void' WHERE id = ?").run(id).changes;
}

function listSuspicious(db, { minScans, minVerifies, limit = 200 }) {
  return db
    .prepare(
      `SELECT l.*, b.status AS batch_status, p.name AS product_name
       FROM labels l
       JOIN batches b ON b.id = l.batch_id
       JOIN products p ON p.id = l.product_id
       WHERE l.scan_count >= ? OR l.verify_count >= ?
       ORDER BY l.verify_count DESC, l.scan_count DESC
       LIMIT ?`,
    )
    .all(minScans, minVerifies, limit);
}

function isVoid(label) {
  return label.status === 'void' || label.batch_status === 'void';
}

function logEvent(db, labelId, type, meta) {
  db.prepare(
    'INSERT INTO events (label_id, type, ip, ip_hash, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    labelId,
    type,
    meta.ip || null,
    meta.ipHash || null,
    (meta.userAgent || '').slice(0, 512) || null,
    nowIso(),
  );
}

// 找標籤並確認產品碼相符；變動碼存在但產品碼不符時視同查無此碼
function lookup(db, productId, code) {
  const label = findLabelByCode(db, code);
  if (!label || label.product_id !== productId) return { label: null, orphan: label };
  return { label, orphan: null };
}

// ---------- 消費者流程 ----------

// 掃描：回傳 { status: 'not_found' | 'void' | 'ok', label, product }
function recordScan(db, { productId, code, ...meta }) {
  return db.transaction(() => {
    const { label, orphan } = lookup(db, productId, code);
    if (!label) {
      logEvent(db, orphan ? orphan.id : null, 'not_found', meta);
      return { status: 'not_found' };
    }
    const now = nowIso();
    db.prepare(
      'UPDATE labels SET scan_count = scan_count + 1, first_scan_at = COALESCE(first_scan_at, ?) WHERE id = ?',
    ).run(now, label.id);
    logEvent(db, label.id, 'scan', meta);
    if (isVoid(label)) return { status: 'void' };
    return {
      status: 'ok',
      label: { ...label, scan_count: label.scan_count + 1, first_scan_at: label.first_scan_at || now },
      product: getProduct(db, productId),
    };
  })();
}

// 驗證：回傳 { status, ... }
//   not_found / void / locked
//   ok_first / ok_repeat：附 first_verify_at、verify_count
//   fail：附 remaining（剩餘可嘗試次數）；用完時改回傳 locked
function verify(db, { productId, code, checkcode, ...meta }) {
  return db.transaction(() => {
    const { label, orphan } = lookup(db, productId, code);
    if (!label) {
      logEvent(db, orphan ? orphan.id : null, 'not_found', meta);
      return { status: 'not_found' };
    }
    if (isVoid(label)) return { status: 'void' };
    if (label.fail_count >= MAX_VERIFY_FAILS) return { status: 'locked' };

    if (!codes.checkcodeMatches(checkcode, label.checkcode)) {
      const failCount = label.fail_count + 1;
      db.prepare('UPDATE labels SET fail_count = ? WHERE id = ?').run(failCount, label.id);
      logEvent(db, label.id, 'verify_fail', meta);
      const remaining = MAX_VERIFY_FAILS - failCount;
      return remaining > 0 ? { status: 'fail', remaining } : { status: 'locked' };
    }

    const now = nowIso();
    const firstVerifyAt = label.first_verify_at || now;
    const verifyCount = label.verify_count + 1;
    db.prepare('UPDATE labels SET verify_count = ?, first_verify_at = ? WHERE id = ?').run(
      verifyCount,
      firstVerifyAt,
      label.id,
    );
    logEvent(db, label.id, 'verify_ok', meta);
    return {
      status: label.verify_count === 0 ? 'ok_first' : 'ok_repeat',
      first_verify_at: firstVerifyAt,
      verify_count: verifyCount,
      product: getProduct(db, productId),
    };
  })();
}

module.exports = {
  MAX_BATCH_QUANTITY,
  MAX_VERIFY_FAILS,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  createBatch,
  getBatch,
  listBatches,
  voidBatch,
  iterateBatchLabels,
  findLabelByCode,
  listLabelEvents,
  voidLabel,
  listSuspicious,
  recordScan,
  verify,
};
