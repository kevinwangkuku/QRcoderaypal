'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const qr = require('../src/lib/qr');
const { buildQrData, generateCode } = require('../src/lib/codes');

test('HTTPS://Q.CO 的 36 字元 qrcodedata 在 M 級糾錯下為 Version 2', () => {
  for (let i = 0; i < 50; i++) {
    const info = qr.analyze(buildQrData('HTTPS://Q.CO', 'A12B3C', generateCode()), 'M');
    assert.deepEqual(info, { length: 36, version: 2, modules: 25 });
  }
});

test('Version 2-M 的英數模式上限是 38 字元', () => {
  assert.equal(qr.analyze('A'.repeat(38), 'M').version, 2);
  assert.equal(qr.analyze('A'.repeat(39), 'M').version, 3);
});

test('SVG：viewBox 以模組為單位並含靜區，只有底色與一條 path', () => {
  const data = buildQrData('HTTPS://Q.CO', 'A12B3C', generateCode());
  const svg = qr.toSvg(data, { ecLevel: 'M', margin: 2 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29"/);
  assert.equal((svg.match(/<rect /g) || []).length, 1);
  assert.equal((svg.match(/<path /g) || []).length, 1);
  assert.doesNotMatch(svg, /width="\d+mm"|<text|<g/);
  assert.equal(qr.toSvg(data, { ecLevel: 'M', margin: 4 }).includes('viewBox="0 0 33 33"'), true);
});
