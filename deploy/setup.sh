#!/usr/bin/env bash
# QR 防偽標籤系統：在 Ubuntu 24.04 主機上安裝或更新。
#
# 第一次安裝與之後更新都用同一個指令（在下載的專案資料夾裡執行）：
#   sudo bash deploy/setup.sh
#
# 會做的事：安裝 Node.js 22 與 Caddy、把程式複製到 /srv/qr-auth、
# 第一次安裝時詢問網域並建立 .env、設定開機自動啟動、HTTPS、每日備份。
# 更新時不會動到 .env、資料庫與上傳的圖片。
set -euo pipefail

APP_DIR=/srv/qr-auth
APP_USER=qrauth
BACKUP_DIR=/var/backups/qr-auth
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" != 0 ]; then
  echo "請用 sudo 執行：sudo bash deploy/setup.sh" >&2
  exit 1
fi

ask() {
  local prompt=$1 default=${2:-} answer
  read -r -p "$prompt${default:+（直接按 Enter 使用：$default）}：" answer
  echo "${answer:-$default}"
}

step() { echo; echo "==== $* ===="; }

step "1/7 安裝系統套件"
apt-get update -y
apt-get install -y curl git rsync sqlite3 openssl ca-certificates gnupg \
  debian-keyring debian-archive-keyring apt-transport-https

step "2/7 安裝 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

step "3/7 安裝 Caddy（負責 HTTPS）"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

step "4/7 複製程式到 $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 \
  || useradd --system --create-home --home-dir "/var/lib/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/data"
rsync -a --delete \
  --exclude .git --exclude .env --exclude data --exclude node_modules \
  "$SRC_DIR/" "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
(cd "$APP_DIR" && sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund)

step "5/7 設定檔 .env"
NEW_PASS=""
if [ -f "$APP_DIR/.env" ]; then
  echo "已有 .env，保留原本設定。"
else
  DOMAIN=$(ask "網域（例如 verify.raypal-bio.com）")
  DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN%%/*}
  DOMAIN=$(echo "$DOMAIN" | tr '[:upper:]' '[:lower:]')
  [ -n "$DOMAIN" ] || { echo "必須輸入網域" >&2; exit 1; }
  CONTACT_PHONE=$(ask "客服電話" "02-8757-8588")
  CONTACT_EMAIL=$(ask "客服 Email" "jeffrey_wang@compal.com")
  NEW_PASS=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-16)
  cat > "$APP_DIR/.env" <<EOF
PORT=3000
BASE_URL=HTTPS://$(echo "$DOMAIN" | tr '[:lower:]' '[:upper:]')
DB_PATH=./data/app.db
UPLOAD_DIR=./data/uploads
ADMIN_USER=admin
ADMIN_PASS=$NEW_PASS
ADMIN_REQUIRE_HTTPS=true
IP_HASH_SALT=$(openssl rand -hex 24)
TRUST_PROXY=loopback
CHECKCODE_ENABLED=false
CONTACT_NAME=
CONTACT_PHONE=$CONTACT_PHONE
CONTACT_EMAIL=$CONTACT_EMAIL
CONTACT_URL=
CONTACT_URL_LABEL=LINE 客服
QR_EC_LEVEL=M
QR_MAX_VERSION=3
QR_MARGIN=2
TZ=Asia/Taipei
EOF
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi
# 設定有誤就在這裡停下並顯示原因
(cd "$APP_DIR" && sudo -u "$APP_USER" node -e "require('dotenv').config({quiet:true}); require('./src/config').loadConfig()")
DOMAIN=$(grep '^BASE_URL=' "$APP_DIR/.env" | cut -d= -f2 | sed 's#^HTTPS://##' | tr '[:upper:]' '[:lower:]')

step "6/7 開機自動啟動與 HTTPS"
cat > /etc/systemd/system/qr-auth.service <<EOF
[Unit]
Description=QR anti-counterfeit label system
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node src/server.js
Restart=always
User=$APP_USER
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable qr-auth
systemctl restart qr-auth

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy || systemctl restart caddy

step "7/7 每日備份（保留 30 天）"
cat > /etc/cron.daily/qr-auth-backup <<EOF
#!/bin/sh
set -e
mkdir -p $BACKUP_DIR
DAY=\$(date +%F)
sqlite3 $APP_DIR/data/app.db ".backup '$BACKUP_DIR/app-\$DAY.db'"
gzip -f "$BACKUP_DIR/app-\$DAY.db"
tar -czf "$BACKUP_DIR/uploads-\$DAY.tar.gz" -C $APP_DIR/data uploads
find $BACKUP_DIR \( -name 'app-*.db.gz' -o -name 'uploads-*.tar.gz' \) -mtime +30 -delete
EOF
chmod 755 /etc/cron.daily/qr-auth-backup

sleep 2
echo
if curl -fsS -o /dev/null http://127.0.0.1:3000/style.css; then
  echo "✅ 程式已啟動"
else
  echo "⚠ 程式沒有回應，請執行：sudo journalctl -u qr-auth -n 50"
fi
echo
echo "後台網址：https://$DOMAIN/admin"
echo "帳號：admin"
if [ -n "$NEW_PASS" ]; then
  echo "密碼：$NEW_PASS"
  echo "（請立刻記到安全的地方；之後可在 $APP_DIR/.env 修改）"
fi
echo
echo "如果網址打不開，通常是 DNS 還沒生效。確認 $DOMAIN 的 A 紀錄指向這台主機的 IP："
curl -fsS https://api.ipify.org 2>/dev/null && echo
