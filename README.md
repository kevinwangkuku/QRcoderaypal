# QR 防偽標籤系統

後台批量產生防偽標籤並匯出給印刷廠；消費者掃描 7×7 mm QR Code 後輸入 checkcode 驗證真偽，系統記錄每次掃描與驗證以偵測複製標籤。

規格見 [SPEC.md](SPEC.md)。

## 快速開始

```bash
npm install
cp .env.example .env     # 修改 ADMIN_PASS、IP_HASH_SALT，本機開發可設 ADMIN_REQUIRE_HTTPS=false
npm test
npm start                # http://localhost:3000/admin
```

需要 Node.js 20.19 以上（`archiver` 8 是純 ESM 套件，需要支援 `require(esm)` 的 Node 版本）。

## 設定

| 變數 | 說明 |
| --- | --- |
| `BASE_URL` | QR 內容的網址前綴。只能用 QR 英數模式字元（全大寫），結尾不加斜線，否則拒絕啟動。**最多 14 字元**才能維持 M 級 Version 2（路徑固定 24 字元，上限 38）。 |
| `ADMIN_USER` / `ADMIN_PASS` | 後台 Basic Auth。密碼至少 12 字元，保留範例值會拒絕啟動。 |
| `ADMIN_REQUIRE_HTTPS` | 預設 `true`，後台只接受 HTTPS。只在本機開發時設為 `false`。 |
| `IP_HASH_SALT` | IP 雜湊用的鹽，至少 16 字元。**上線後不要更換**，否則新舊紀錄的 IP 雜湊無法對照。 |
| `TRUST_PROXY` | Express `trust proxy`，預設 `loopback`（反向代理在同一台機器）。 |
| `QR_EC_LEVEL` / `QR_MAX_VERSION` / `QR_MARGIN` | QR 糾錯等級、版本警告門檻、SVG 靜區模組數。 |
| `DB_PATH` | SQLite 檔案位置。 |
| `UPLOAD_DIR` | 後台上傳的產品圖片存放位置，預設 `./data/uploads`。備份時要一起備份。 |
| `TZ` | 顯示時區，預設 `Asia/Taipei`。資料庫一律存 UTC。 |

## 部署

### 1. 常駐執行

**PM2**

```bash
npm ci --omit=dev
pm2 start src/server.js --name qr-auth
pm2 save && pm2 startup
```

**systemd**（`/etc/systemd/system/qr-auth.service`）

```ini
[Unit]
Description=QR anti-counterfeit
After=network.target

[Service]
WorkingDirectory=/srv/qr-auth
ExecStart=/usr/bin/node src/server.js
Restart=always
User=qrauth
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now qr-auth
```

### 2. HTTPS 反向代理

程式本身只聽 HTTP，由 Caddy 或 nginx 提供 HTTPS。Express 已依 `TRUST_PROXY` 設定 `trust proxy`，會從 `X-Forwarded-For` / `X-Forwarded-Proto` 取得真實 IP 與協定；限流與「後台只限 HTTPS」都依賴這兩個標頭，所以反向代理一定要帶上。

**Caddy**（自動申請憑證）

```
q.co {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx**

```nginx
server {
    listen 443 ssl http2;
    server_name q.co;
    # ssl_certificate ...;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;   # 大批次 SVG ZIP 下載需要較長時間
    }
}
```

QR 內容是大寫網址（`HTTPS://Q.CO/...`）。網域不分大小寫，路由也接受大寫與小寫，不需額外設定。

### 3. SQLite 每日備份

資料庫開啟 WAL 模式，**不要直接複製 `.db` 檔**（可能拿到不一致的內容）。用 SQLite 的線上備份：

```bash
# /etc/cron.daily/qr-auth-backup
#!/bin/sh
set -e
DEST=/var/backups/qr-auth
mkdir -p "$DEST"
sqlite3 /srv/qr-auth/data/app.db ".backup '$DEST/app-$(date +%F).db'"
gzip -f "$DEST/app-$(date +%F).db"
# 產品圖片不在資料庫裡，要另外備份
tar -czf "$DEST/uploads-$(date +%F).tar.gz" -C /srv/qr-auth/data uploads
find "$DEST" \( -name 'app-*.db.gz' -o -name 'uploads-*.tar.gz' \) -mtime +30 -delete
```

建議再把備份同步到另一台機器或雲端儲存，並定期實際還原測試一次。

### 4. 上線前檢查

- [ ] 正式網域的 `BASE_URL` ≤ 14 字元；後台「建立批次」預覽顯示 Version 2、沒有紅色警告
- [ ] 以 **iOS 與 Android 原生相機**實際掃描**印刷後**的 7 mm 標籤，確認能辨識並開啟驗證頁
- [ ] 後台以 HTTP 存取會被拒絕（`ADMIN_REQUIRE_HTTPS=true`）
- [ ] `ADMIN_PASS`、`IP_HASH_SALT` 已換成強隨機值
- [ ] 備份排程已執行過一次並成功還原

## 效能

| 項目 | 10 萬張 |
| --- | --- |
| 建立批次（單一 transaction） | 約 1.5 秒 |
| 下載 Excel | 約 1 秒 |
| 下載 SVG ZIP | 約 80 秒，約 78 MB |

SVG ZIP 的時間幾乎都花在 QR 編碼（每張約 0.5 ms）。下載以串流方式進行，期間不影響消費者掃描與驗證。

## 專案結構

```
src/
  app.js              Express 設定與路由掛載（/admin → /verify → /:product/:code）
  server.js           啟動
  config.js           讀取並驗證 .env
  db/                 連線、migration 執行器、migrations/*.sql
  lib/codes.js        變動碼、checkcode、qrcodedata 組裝與正規化
  lib/qr.js           QR 編碼、版本計算、SVG 輸出
  lib/export.js       Excel、ZIP 串流匯出
  lib/ip.js           IP 加鹽雜湊
  lib/time.js         時間格式（UTC 存、台北時間顯示）
  services/labels.js  產品、批次、標籤、掃描與驗證的資料庫邏輯
  routes/public.js    掃描與驗證
  routes/admin.js     後台（Basic Auth、HTTPS 限制、CSRF）
  views/              EJS 模板
  public/             CSS
test/                 node:test + supertest
```

新增資料表或欄位時，在 `src/db/migrations/` 新增 `002_xxx.sql`，啟動時會自動套用。
