'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const URL_PREFIX = '/uploads/';

// 依檔頭判斷實際格式，不信任副檔名與瀏覽器送來的 Content-Type。
// 刻意不支援 SVG：SVG 可以夾帶腳本。
function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

// 以隨機檔名存檔，回傳給 image_url 用的路徑；不是支援的圖片格式回傳 null
function saveImage(dir, buf) {
  const ext = detectImageType(buf);
  if (!ext) return null;
  const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf, { flag: 'wx' });
  return URL_PREFIX + name;
}

function isUploaded(imageUrl) {
  return typeof imageUrl === 'string' && imageUrl.startsWith(URL_PREFIX);
}

// 刪除先前上傳的檔案；外部網址不處理
function deleteImage(dir, imageUrl) {
  if (!isUploaded(imageUrl)) return;
  fs.rm(path.join(dir, path.basename(imageUrl)), { force: true }, () => {});
}

module.exports = { MAX_IMAGE_BYTES, URL_PREFIX, detectImageType, saveImage, isUploaded, deleteImage };
