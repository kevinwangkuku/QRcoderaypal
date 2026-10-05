'use strict';

const crypto = require('node:crypto');

// IP 加鹽後做 SHA-256，用來比對同一來源（舊紀錄只有這個欄位）
function hashIp(ip, salt) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

// IPv4 在雙堆疊環境會以 ::ffff:1.2.3.4 出現，存成一般寫法方便閱讀
function normalizeIp(ip) {
  if (!ip) return null;
  return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
}

module.exports = { hashIp, normalizeIp };
