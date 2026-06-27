# SuperShort Pi 5 Deployment

This deploys the SuperShort live data + paper trading dashboard on Raspberry Pi 5.

Version 1 does not place real Binance orders. It uses Binance market WebSocket data and optional signed read-only account APIs.

## 1. Install Runtime

```bash
sudo apt update
sudo apt install -y git curl build-essential python3 make g++
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 2. Install App

```bash
sudo mkdir -p /opt/supershort /var/lib/supershort /etc/supershort
sudo chown -R pi:pi /opt/supershort /var/lib/supershort
cd /opt/supershort
npm ci
npm run build
```

## 3. Create Admin Password Hash

Run this from the app directory:

```bash
node -e "import('./dist/server/config.js').then(m => console.log(m.hashPassword(process.argv[1])))" 'YOUR_PASSWORD_HERE'
```

Copy the printed hash into `/etc/supershort/supershort.env`.

## 4. Environment File

Create `/etc/supershort/supershort.env`:

```bash
NODE_ENV=production
PORT=8787
DATABASE_PATH=/var/lib/supershort/supershort.db
SYMBOL=BTCUSDC
BINANCE_BASE_URL=https://fapi.binance.com
BINANCE_WS_BASE_URL=wss://fstream.binance.com
BINANCE_API_KEY=
BINANCE_API_SECRET=
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=scrypt:replace:this
SESSION_SECRET=replace-with-openssl-rand-hex-32
RAW_RETENTION_DAYS=7
```

Generate a session secret:

```bash
openssl rand -hex 32
```

Use a restricted Binance key. For version 1, prefer read-only permissions where possible. Do not enable withdrawals.

## 5. Install systemd Services

```bash
sudo cp deploy/supershort-api.service /etc/systemd/system/
sudo cp deploy/supershort-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable supershort-api supershort-worker
sudo systemctl start supershort-api supershort-worker
sudo systemctl status supershort-api supershort-worker
```

View logs:

```bash
journalctl -u supershort-api -f
journalctl -u supershort-worker -f
```

## 6. Cloudflare Tunnel

Install and authenticate `cloudflared`, then create a tunnel for your dashboard hostname.

Example config:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp deploy/cloudflared-config.example.yml /etc/cloudflared/config.yml
sudo cloudflared service install
sudo systemctl restart cloudflared
```

The tunnel should forward your dashboard hostname to:

```text
http://127.0.0.1:8787
```

## 7. Smoke Test

```bash
curl http://127.0.0.1:8787/api/health
```

Open:

```text
https://your-dashboard.example.com
```

Expected:

- Login page appears in Traditional Chinese.
- Dashboard loads after login.
- System status shows API running.
- Worker connects to Binance WebSocket.
- No real order API is called in version 1.
