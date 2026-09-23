'use strict';

const crypto = require('node:crypto');

// IP 加鹽後做 SHA-256，資料庫不存明碼
function hashIp(ip, salt) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

module.exports = { hashIp };
