# QR 防偽標籤系統 — 實作規格

這是全新專案，不沿用任何舊程式碼。請先閱讀整份規格，列出實作計畫與檔案結構給我確認，確認後再動手。

## 1. 目標

1. 後台批量產生防偽標籤：每張標籤有唯一變動碼，並輸出 Excel 交給印刷廠。
2. 消費者掃描 7×7 mm 小標籤上的 QR Code，進入驗證頁。
3. 消費者輸入標籤上另外印的 checkcode（刮刮層下或包裝內側），完成真偽驗證。
4. 系統記錄每次掃描與驗證，用來偵測被複製的標籤。

## 2. 技術棧

- Node.js 20+、Express
- SQLite，使用 `better-sqlite3`
- QR 產生：`qrcode-generator`（必須用 Alphanumeric 模式，見第 4 節）
- Excel：`exceljs`
- ZIP 打包 SVG：`archiver`
- 頁面：EJS 伺服器端渲染，介面用繁體中文，驗證頁以手機版為主
- 限流：`express-rate-limit`
- 設定：`dotenv`
- 測試：`node:test` + `supertest`
- 不使用前端框架，不使用瀏覽器 localStorage 存任何業務資料

## 3. 設定（.env）

```
PORT=3000
BASE_URL=HTTPS://Q.CO        # 暫定，正式網域確定後替換；必須全大寫、結尾不加斜線
DB_PATH=./data/app.db
ADMIN_USER=admin
ADMIN_PASS=請改成強密碼
QR_EC_LEVEL=M                # L / M / Q / H
QR_MAX_VERSION=2             # 產生批次時若超過此版本要警告
QR_MARGIN=2                  # SVG 靜區模組數
TZ=Asia/Taipei
```

啟動時驗證 BASE_URL：只能包含 QR 英數模式字元（`0-9 A-Z 空白 $ % * + - . / :`），不符合就拒絕啟動並顯示原因。附一份 `.env.example`。

## 4. 碼的格式（核心規則）

### qrcodedata

```
{BASE_URL}/{產品碼}/{變動碼}
例：HTTPS://Q.CO/A12B3C/7K3M9QXR2T8VWZ4N
```

- 整串必須全大寫，並且只含 QR Alphanumeric 字元，才能用英數模式編碼（每字元約 5.5 bits，Byte 模式是 8 bits）。
- 目標：以 M 級糾錯落在 Version 2（25×25 模組）以內。

### 產品碼（id）

- 6 字元，`[0-9A-Z]`，由管理者建立產品時自訂，唯一。

### 變動碼

- 16 字元 Crockford Base32，字母表：`0123456789ABCDEFGHJKMNPQRSTVWXYZ`
- 由 `crypto.randomBytes` 產生 80 bits 隨機值；不可用 `Math.random`。
- 資料庫設 UNIQUE；碰撞時重試。

### checkcode

- 6 字元 Crockford Base32 隨機值，用 `crypto.randomBytes` 產生。
- 絕對不能出現在 QR 內容中，也不能從 qrcodedata 推算出來。
- 使用者輸入時要正規化：轉大寫、去空白，並把 `O→0`、`I→1`、`L→1`。
- 比對使用 `crypto.timingSafeEqual`。

請把以上邏輯集中在 `src/lib/codes.js`，並寫單元測試。

## 5. 資料庫

```sql
products (
  id TEXT PRIMARY KEY,            -- 6 碼產品碼
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL
)

batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active / void
  created_at TEXT NOT NULL
)

labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  sn INTEGER NOT NULL,                     -- 批次內流水號，從 1 開始
  code TEXT NOT NULL UNIQUE,               -- 16 碼變動碼
  checkcode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active / void
  scan_count INTEGER NOT NULL DEFAULT 0,
  first_scan_at TEXT,
  verify_count INTEGER NOT NULL DEFAULT 0,
  first_verify_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, sn)
)

events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id INTEGER REFERENCES labels(id),  -- 查無此碼時為 NULL
  type TEXT NOT NULL,                      -- scan / verify_ok / verify_fail / not_found
  ip_hash TEXT,                            -- IP 做 SHA-256 加鹽雜湊，不存明碼
  user_agent TEXT,
  created_at TEXT NOT NULL
)
```

- 用簡單的 migration 機制（`migrations/` 資料夾 + 版本表），啟動時自動執行。
- 開啟 WAL 模式與外鍵檢查。
- 批次產生必須在單一 transaction 內完成；10 萬筆要能在數秒內完成。

## 6. 消費者端

### GET /:product/:code

- 路由用正規式限定格式：產品碼 `[0-9A-Z]{6}`、變動碼 16 碼 Crockford Base32，大小寫不拘，進來後一律轉大寫。
- 必須排在 `/admin` 等路由之後，避免衝突。
- 查無此碼、或產品碼與變動碼不相符 → 顯示「查無此標籤，可能為仿冒品」，記錄 `not_found`。
- 標籤或批次已作廢 → 顯示「此標籤已作廢」。
- 找到 → `scan_count + 1`，首次掃描則寫入 `first_scan_at`，記錄 `scan`，然後顯示：
  - 產品名稱、圖片、說明
  - 此碼已被查詢幾次、首次查詢時間
  - checkcode 輸入框與「驗證」按鈕

### POST /verify

- 參數：product、code、checkcode。
- 限流：同一 IP 每 15 分鐘最多 20 次。
- 同一標籤累計失敗 10 次後鎖定，顯示「請聯絡客服」。
- 結果頁三種情況：
  1. 驗證成功且為首次驗證 → 「✅ 正品驗證成功」
  2. 驗證成功但先前已驗證過 → 「⚠️ 此標籤已於 {first_verify_at} 驗證過，共 {verify_count} 次。若不是您本人驗證，這件商品可能是複製標籤的仿冒品」
  3. checkcode 錯誤 → 「驗證碼錯誤」，顯示剩餘可嘗試次數
- 時間一律以 Asia/Taipei 顯示。

## 7. 管理後台（/admin）

所有 /admin 路由用 HTTP Basic Auth（帳密來自 .env），只能在 HTTPS 下使用。

1. **產品管理**：新增、編輯、列表。產品碼建立後不可修改。
2. **建立批次**：選擇產品、輸入數量（上限 100,000）與備註。送出前先預覽：
   - 範例 qrcodedata 與字元數
   - 以設定的糾錯等級實際編碼後的 QR 版本與模組數，超過 `QR_MAX_VERSION` 時顯示紅色警告
   - 以實際 7×7 mm 大小顯示範例 QR（CSS 用 mm 單位）
3. **批次列表**：顯示產品、數量、建立時間、已掃描張數、已驗證張數。每個批次提供：
   - 下載 Excel
   - 下載 SVG ZIP（檔名 `{sn}.svg`）
   - 作廢整個批次
4. **標籤查詢**：輸入變動碼，查看該標籤的所有事件紀錄，可單張作廢。
5. **可疑標籤**：列出 `scan_count` 或 `verify_count` 異常偏高的標籤（門檻可在頁面上調整），依次數排序。

## 8. 匯出格式

### Excel（交給印刷廠）

- 工作表名稱：`labels`
- 欄位依序：`sn`、`id`、`qrcodedata`、`checkcode`
- 全部欄位設為文字格式，避免 Excel 把 `0012AB` 這類值轉成數字或科學記號。
- 大批次用 exceljs 的 streaming writer，避免記憶體爆掉。
- 檔名：`{產品碼}_batch{批次id}_{日期}.xlsx`

### SVG

- `qrcode-generator`：`typeNumber = 0`（自動）、糾錯等級取 `QR_EC_LEVEL`，`addData(str, 'Alphanumeric')`。
- 輸出純向量 SVG，無底色以外的多餘元素，`viewBox` 以模組為單位，方便印刷時縮放到 7 mm。
- 靜區模組數取 `QR_MARGIN`。

## 9. 專案結構（建議）

```
src/
  app.js            Express 設定與路由掛載
  server.js         啟動
  config.js         讀取並驗證 .env
  db/               連線、migrations
  lib/codes.js      變動碼、checkcode、qrcodedata 組裝與正規化
  lib/qr.js         QR 編碼、版本計算、SVG 輸出
  lib/export.js     Excel、ZIP 匯出
  routes/public.js  掃描與驗證
  routes/admin.js   後台
  views/            EJS 模板
  public/           CSS
test/
```

## 10. 測試（必須通過）

- 變動碼：長度 16、字元都在 Crockford 字母表內、產生 10 萬筆無重複。
- qrcodedata：全部字元都在 QR Alphanumeric 字元集內；以 `HTTPS://Q.CO` 為例，36 字元在 M 級糾錯下編碼結果為 Version 2。
- checkcode 正規化：小寫、空白、`O/I/L` 都能正確比對。
- 掃描流程：正確碼、錯誤碼、產品碼不符、作廢標籤、大小寫混用。
- 驗證流程：首次成功、重複成功、失敗、失敗達上限後鎖定、限流。
- Excel 匯出：欄位順序正確，值為文字格式。

## 11. 部署說明（寫進 README）

- 以 PM2 或 systemd 常駐。
- 前面架 Caddy 或 nginx 提供 HTTPS，Express 設定 `trust proxy`。
- SQLite 檔案每日備份的做法。
- 上線前以 iOS 與 Android 原生相機實際掃描印刷後的 7 mm 標籤。
