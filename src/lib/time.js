'use strict';

// 資料庫一律存 UTC ISO 字串，顯示時才轉成設定的時區

function nowIso() {
  return new Date().toISOString();
}

function parts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

// '2026-09-23 14:05:09'；null 回傳空字串
function formatTime(iso, tz) {
  if (!iso) return '';
  const p = parts(new Date(iso), tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// '20260923'，用於檔名
function dateStamp(date, tz) {
  const p = parts(date, tz);
  return `${p.year}${p.month}${p.day}`;
}

module.exports = { nowIso, formatTime, dateStamp };
