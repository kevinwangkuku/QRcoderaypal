'use strict';

const qrcode = require('qrcode-generator');

function encode(data, ecLevel) {
  const qr = qrcode(0, ecLevel); // typeNumber 0：自動選最小版本
  qr.addData(data, 'Alphanumeric');
  qr.make();
  return qr;
}

// 回傳字元數、QR 版本與模組數
function analyze(data, ecLevel) {
  const modules = encode(data, ecLevel).getModuleCount();
  return { length: data.length, version: (modules - 17) / 4, modules };
}

// 純向量 SVG：白底 + 一條黑色 path，viewBox 以模組為單位
function toSvg(data, { ecLevel, margin }) {
  const qr = encode(data, ecLevel);
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  let d = '';
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!qr.isDark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < n && qr.isDark(row, col)) col++;
      d += `M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${d}" fill="#000"/>` +
    '</svg>'
  );
}

module.exports = { encode, analyze, toSvg };
