'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const codes = require('../src/lib/codes');
const { loadConfig } = require('../src/config');
const { TEST_ENV } = require('./helpers');

const ALPHABET = new Set(codes.CROCKFORD);

test('Crockford 字母表為 32 字元且不含 I L O U', () => {
  assert.equal(codes.CROCKFORD.length, 32);
  for (const ch of 'ILOU') assert.ok(!ALPHABET.has(ch));
});

test('Crockford 轉換：已知位元對應', () => {
  assert.equal(codes.toCrockford(Buffer.alloc(10, 0x00), 16), '0000000000000000');
  assert.equal(codes.toCrockford(Buffer.alloc(10, 0xff), 16), 'ZZZZZZZZZZZZZZZZ');
  assert.equal(codes.toCrockford(Buffer.from([0x08, 0x86, 0x42, 0x98, 0xe8]), 8), '12345678');
});

test('變動碼：長度 16、字元都在 Crockford 字母表內', () => {
  for (let i = 0; i < 1000; i++) {
    const code = codes.generateCode();
    assert.equal(code.length, 16);
    for (const ch of code) assert.ok(ALPHABET.has(ch), `非法字元 ${ch}`);
    assert.match(code, codes.CODE_RE);
  }
});

test('變動碼：產生 10 萬筆無重複', () => {
  const set = new Set();
  for (let i = 0; i < 100000; i++) set.add(codes.generateCode());
  assert.equal(set.size, 100000);
});

test('checkcode：長度 6、字元都在 Crockford 字母表內', () => {
  for (let i = 0; i < 1000; i++) {
    const c = codes.generateCheckcode();
    assert.equal(c.length, 6);
    assert.match(c, codes.CHECKCODE_RE);
  }
});

test('qrcodedata：格式正確且全部字元都在 QR Alphanumeric 字元集內', () => {
  for (let i = 0; i < 1000; i++) {
    const data = codes.buildQrData('HTTPS://Q.CO', 'A12B3C', codes.generateCode());
    assert.equal(data.length, 36);
    assert.match(data, /^HTTPS:\/\/Q\.CO\/A12B3C\/[0-9A-Z]{16}$/);
    assert.ok(codes.isQrAlphanumeric(data));
  }
  assert.ok(!codes.isQrAlphanumeric('https://q.co'));
  assert.ok(!codes.isQrAlphanumeric('HTTPS://Q.CO/?A=1'));
});

test('checkcode 正規化：小寫、空白、連字號、O/I/L', () => {
  assert.equal(codes.normalizeCheckcode(' 7k3 m9q '), '7K3M9Q');
  assert.equal(codes.normalizeCheckcode('o1-iL0'), '01110');
  assert.equal(codes.normalizeCheckcode(undefined), '');
});

test('checkcode 比對：正規化後相符才通過', () => {
  const stored = '0A1B1C';
  assert.ok(codes.checkcodeMatches('0A1B1C', stored));
  assert.ok(codes.checkcodeMatches('oa1b1c', stored));
  assert.ok(codes.checkcodeMatches('Oa I b L c', stored));
  assert.ok(codes.checkcodeMatches('0a-1b-1c', stored));
  assert.ok(!codes.checkcodeMatches('0A1B1D', stored));
  assert.ok(!codes.checkcodeMatches('0A1B1', stored));
  assert.ok(!codes.checkcodeMatches('0A1B1CC', stored));
  assert.ok(!codes.checkcodeMatches('', stored));
});

test('產品碼與變動碼正規化：大小寫不拘、格式不符回傳 null', () => {
  assert.equal(codes.normalizeProductId('a12b3c'), 'A12B3C');
  assert.equal(codes.normalizeProductId('A12B3'), null);
  assert.equal(codes.normalizeProductId('A12B3C!'), null);
  assert.equal(codes.normalizeCode('7k3m9qxr2t8vwz4n'), '7K3M9QXR2T8VWZ4N');
  assert.equal(codes.normalizeCode('7K3M9QXR2T8VWZ4U'), null); // U 不在字母表
  assert.equal(codes.normalizeCode('7K3M9QXR2T8VWZ4'), null);
});

test('設定：BASE_URL 含非英數模式字元時拒絕啟動', () => {
  assert.throws(() => loadConfig({ ...TEST_ENV, BASE_URL: 'https://q.co' }), /BASE_URL/);
  assert.throws(() => loadConfig({ ...TEST_ENV, BASE_URL: 'HTTPS://Q.CO/' }), /斜線/);
  assert.throws(() => loadConfig({ ...TEST_ENV, BASE_URL: 'HTTPS://Q_CO' }), /BASE_URL/);
  assert.throws(() => loadConfig({ ...TEST_ENV, BASE_URL: '' }), /BASE_URL/);
  assert.equal(loadConfig(TEST_ENV).baseUrl, 'HTTPS://Q.CO');
});

test('設定：密碼與鹽為範例值或過短時拒絕啟動', () => {
  assert.throws(() => loadConfig({ ...TEST_ENV, ADMIN_PASS: '請改成強密碼' }), /ADMIN_PASS/);
  assert.throws(() => loadConfig({ ...TEST_ENV, ADMIN_PASS: 'short' }), /ADMIN_PASS/);
  assert.throws(() => loadConfig({ ...TEST_ENV, IP_HASH_SALT: '' }), /IP_HASH_SALT/);
  assert.throws(() => loadConfig({ ...TEST_ENV, QR_EC_LEVEL: 'X' }), /QR_EC_LEVEL/);
});
