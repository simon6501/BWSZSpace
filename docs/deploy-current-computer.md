# Deploy On Current Computer

This project can run directly on this computer as a small private server.

## 1. Prepare production env

Copy the template:

```bash
cp .env.server.example .env
```

Edit `.env`:

```env
HOST=127.0.0.1
PORT=3077
LOGIN_DISABLED=false
SESSION_SECRET=replace-with-a-long-random-secret
```

If `data/users.json` already exists, `APP_PASSWORD` will not overwrite it. Change password with:

```bash
node scripts/set_password.js "your-strong-password"
```

Do not use `secret` for public access.

## 2. Run in background

Start:

```bash
./scripts/start_server.sh
```

Status:

```bash
./scripts/status_server.sh
```

Logs:

```bash
./scripts/tail_server_log.sh
```

Stop:

```bash
./scripts/stop_server.sh
```

Local URL:

```text
http://127.0.0.1:3077
```

## 3. LAN access

If you want phones or another computer on the same Wi-Fi to access directly, set:

```env
HOST=0.0.0.0
```

Then restart:

```bash
./scripts/stop_server.sh
./scripts/start_server.sh
```

Find local IP:

```bash
hostname -I
```

Open from another device:

```text
http://YOUR_LAN_IP:3077
```

## 4. Public access from this computer

Recommended: Cloudflare Tunnel.

Keep app local-only:

```env
HOST=127.0.0.1
PORT=3077
LOGIN_DISABLED=false
```

Then expose this local app through Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:3077
```

For long-term use, create a named Cloudflare Tunnel and bind it to your domain, for example:

```text
https://space.yourdomain.com -> http://127.0.0.1:3077
```

## 5. Data and backups

Main data:

```text
data/bwsz-space.sqlite
data/bwsz-space.sqlite-wal
data/bwsz-space.sqlite-shm
```

Latest automatic app backup:

```text
data/backups/bwsz-space-latest.sqlite
```

Still back up the whole `data/` directory periodically, especially before system updates.

## 6. Install cloudflared locally in this project

If `cloudflared` is not installed globally, install it into `./bin/cloudflared`:

```bash
npm run cloudflared:install
```

Then start a temporary public tunnel:

```bash
npm run tunnel:temp
```

Copy the generated `https://*.trycloudflare.com` URL and open it from mobile data.

Cloudflare's official docs describe quick tunnels as a way to expose local development services with:

```bash
cloudflared tunnel --url http://localhost:8080
```

For this app, the local service is:

```text
http://127.0.0.1:3077
```
