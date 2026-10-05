'use strict';

const { isQrAlphanumeric } = require('./lib/codes');

const PLACEHOLDERS = new Set(['請改成強密碼', '請改成隨機字串']);

function parseIntIn(name, raw, fallback, min, max) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必須是 ${min} 到 ${max} 之間的整數，目前是「${raw}」`);
  }
  return value;
}

function parseTrustProxy(raw) {
  if (raw === undefined || raw === '') return 'loopback';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

function requireSecret(name, raw, minLength) {
  if (!raw || PLACEHOLDERS.has(raw)) {
    throw new Error(`${name} 未設定或仍是範例值，請在 .env 中改掉`);
  }
  if (raw.length < minLength) {
    throw new Error(`${name} 長度至少 ${minLength} 字元`);
  }
  return raw;
}

function parseContactUrl(raw) {
  if (!raw) return '';
  if (!/^https?:\/\/\S+$/i.test(raw)) throw new Error(`CONTACT_URL 必須以 http:// 或 https:// 開頭，目前是「${raw}」`);
  return raw;
}

// 讀取並驗證設定；不合法時丟出含原因的 Error
function loadConfig(env = process.env) {
  const baseUrl = env.BASE_URL;
  if (!baseUrl) throw new Error('BASE_URL 未設定');
  if (!isQrAlphanumeric(baseUrl)) {
    throw new Error(
      `BASE_URL「${baseUrl}」含有 QR 英數模式以外的字元；只能使用 0-9 A-Z 空白 $ % * + - . / :（必須全大寫）`,
    );
  }
  if (baseUrl.endsWith('/')) throw new Error('BASE_URL 結尾不可加斜線');

  const ecLevel = (env.QR_EC_LEVEL || 'M').toUpperCase();
  if (!['L', 'M', 'Q', 'H'].includes(ecLevel)) {
    throw new Error(`QR_EC_LEVEL 必須是 L / M / Q / H，目前是「${env.QR_EC_LEVEL}」`);
  }

  if (!env.ADMIN_USER) throw new Error('ADMIN_USER 未設定');
  if (env.ADMIN_USER === 'logout') throw new Error('ADMIN_USER 不可使用 logout（保留給登出功能）');

  return {
    port: parseIntIn('PORT', env.PORT, 3000, 1, 65535),
    baseUrl,
    dbPath: env.DB_PATH || './data/app.db',
    uploadDir: env.UPLOAD_DIR || './data/uploads',
    adminUser: env.ADMIN_USER,
    adminPass: requireSecret('ADMIN_PASS', env.ADMIN_PASS, 12),
    adminRequireHttps: env.ADMIN_REQUIRE_HTTPS !== 'false',
    // false：不使用驗證碼，只以「是否首次查詢」判斷；驗證碼仍會產生並匯出，隨時可再開啟
    checkcodeEnabled: env.CHECKCODE_ENABLED !== 'false',
    ipHashSalt: requireSecret('IP_HASH_SALT', env.IP_HASH_SALT, 16),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    qrEcLevel: ecLevel,
    qrMaxVersion: parseIntIn('QR_MAX_VERSION', env.QR_MAX_VERSION, 2, 1, 40),
    qrMargin: parseIntIn('QR_MARGIN', env.QR_MARGIN, 2, 0, 10),
    tz: env.TZ || 'Asia/Taipei',
    // 消費者頁面的聯絡資訊；沒設定的欄位不顯示
    contact: {
      name: env.CONTACT_NAME || '',
      phone: env.CONTACT_PHONE || '',
      email: env.CONTACT_EMAIL || '',
      url: parseContactUrl(env.CONTACT_URL),
      urlLabel: env.CONTACT_URL_LABEL || '線上客服',
    },
  };
}

module.exports = { loadConfig };
