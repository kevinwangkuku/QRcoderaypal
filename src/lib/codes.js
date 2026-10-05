'use strict';

const crypto = require('node:crypto');

// Crockford Base32：不含 I、L、O、U
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const CODE_LENGTH = 16; // 16 × 5 = 80 bits
const CHECKCODE_LENGTH = 6; // 6 × 5 = 30 bits

const PRODUCT_ID_RE = /^[0-9A-Z]{6}$/;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const CHECKCODE_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
// QR Alphanumeric 模式可用字元：0-9 A-Z 空白 $ % * + - . / :
const QR_ALNUM_RE = /^[0-9A-Z $%*+\-./:]*$/;

// 從 buf 開頭依序取 5 bits 轉成 Crockford 字元（MSB 優先），不會有取模偏差
function toCrockford(buf, length) {
  let out = '';
  let bits = 0;
  let value = 0;
  let i = 0;
  while (out.length < length) {
    if (bits < 5) {
      value = ((value << 8) | buf[i++]) & 0xffff;
      bits += 8;
    }
    out += CROCKFORD[(value >> (bits - 5)) & 31];
    bits -= 5;
  }
  return out;
}

function randomCrockford(length) {
  return toCrockford(crypto.randomBytes(Math.ceil((length * 5) / 8)), length);
}

function generateCode() {
  return randomCrockford(CODE_LENGTH);
}

function generateCheckcode() {
  return randomCrockford(CHECKCODE_LENGTH);
}

function buildQrData(baseUrl, productId, code) {
  return `${baseUrl}/${productId}/${code}`;
}

function isQrAlphanumeric(str) {
  return typeof str === 'string' && QR_ALNUM_RE.test(str);
}

// 回傳正規化後的產品碼；格式不符回傳 null
function normalizeProductId(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase();
  return PRODUCT_ID_RE.test(s) ? s : null;
}

// 回傳正規化後的變動碼；格式不符回傳 null
function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

// 後台查詢用：接受 16 碼變動碼，或整串 QR 網址（取最後一段）；找不到回傳 null
function extractCode(input) {
  if (typeof input !== 'string') return null;
  const path = input.trim().split(/[?#]/)[0];
  const last = path.split('/').filter(Boolean).pop() || '';
  return normalizeCode(last.replace(/\s+/g, ''));
}

// 使用者輸入的 checkcode：轉大寫、去空白與連字號、O→0、I/L→1
function normalizeCheckcode(input) {
  if (typeof input !== 'string') return '';
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function checkcodeMatches(input, stored) {
  const a = Buffer.from(normalizeCheckcode(input));
  const b = Buffer.from(stored);
  if (a.length !== b.length) {
    // 仍做一次比對，讓長度錯誤與內容錯誤的耗時相近
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  CROCKFORD,
  CODE_LENGTH,
  CHECKCODE_LENGTH,
  PRODUCT_ID_RE,
  CODE_RE,
  CHECKCODE_RE,
  QR_ALNUM_RE,
  toCrockford,
  generateCode,
  generateCheckcode,
  buildQrData,
  isQrAlphanumeric,
  normalizeProductId,
  normalizeCode,
  extractCode,
  normalizeCheckcode,
  checkcodeMatches,
};
