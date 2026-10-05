'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDb } = require('../src/db');

test('既有資料庫升級：加上 ip 欄位，舊紀錄保留且 ip 為 NULL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-auth-migrate-'));
  const file = path.join(dir, 'app.db');
  try {
    // 模擬只套用過 001 的舊資料庫
    const old = new Database(file);
    old.exec(fs.readFileSync(path.join(__dirname, '../src/db/migrations/001_init.sql'), 'utf8'));
    old.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES ('001_init', 'x')");
    old.prepare("INSERT INTO events (type, ip_hash, created_at) VALUES ('not_found', 'abc', '2026-01-01')").run();
    old.close();

    const db = openDb(file);
    const cols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    assert.ok(cols.includes('ip'));
    const row = db.prepare('SELECT * FROM events').get();
    assert.equal(row.ip_hash, 'abc');
    assert.equal(row.ip, null);
    db.close();

    // 再開一次不會重複套用
    openDb(file).close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
