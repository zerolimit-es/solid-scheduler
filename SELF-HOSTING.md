# Self-Hosting Guide

Everything you need to run SolidScheduler on your own server.

## Prerequisites

- A Linux server (Ubuntu 22+, Debian 12+, or similar)
- Docker and Docker Compose v2
- A domain name pointed at your server (for HTTPS)
- A Solid Pod account (free — see [Solid Pod Setup](#solid-pod-setup) below)

## Quick Start

```bash
git clone https://github.com/zerolimit-es/solid-scheduler.git
cd solid-scheduler
cp .env.example .env
# Edit .env — at minimum set SESSION_SECRET and your domain
docker compose up -d
```

This builds the frontend and backend inside Docker and starts everything. The app is available on port 80 (HTTP). For production, you need HTTPS — see the next section.

### Generate a session secret

```bash
openssl rand -hex 32
```

Paste the result into `SESSION_SECRET` in your `.env` file.

## HTTPS Setup

SolidScheduler requires HTTPS in production (Solid OIDC and session cookies depend on it). Choose one of the options below.

### Option A: Caddy (recommended — automatic HTTPS)

Caddy obtains and renews Let's Encrypt certificates automatically. Zero configuration.

1. Set these in your `.env`:
   ```
   DOMAIN=scheduler.example.com
   BASE_URL=https://scheduler.example.com
   FRONTEND_URL=https://scheduler.example.com
   FRONTEND_PORT=127.0.0.1:3000
   ```

2. Start with the Caddy override:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
   ```

That's it. Caddy handles certificate issuance and renewal.

### Option B: Nginx + Let's Encrypt (Certbot)

1. Edit `docker/nginx/nginx.conf` — replace every instance of `your-domain.com` with your actual domain.

2. Set `FRONTEND_PORT=127.0.0.1:3000` in your `.env` so nginx handles port 80/443.

3. Obtain a certificate:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.nginx.yml run --rm \
     certbot certonly --webroot -w /var/www/certbot \
     -d scheduler.example.com --email you@example.com --agree-tos
   ```

4. Start everything:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d
   ```

5. Set up automatic renewal (add to crontab):
   ```bash
   0 3 * * * cd /path/to/solid-scheduler && docker compose -f docker-compose.yml -f docker-compose.nginx.yml run --rm certbot renew && docker compose -f docker-compose.yml -f docker-compose.nginx.yml exec nginx nginx -s reload
   ```

### Option C: Existing reverse proxy

If you already run a reverse proxy (Traefik, HAProxy, etc.), point it at the frontend container on port 80. The frontend container handles both static assets and API proxying to the backend.

## Solid Pod Setup

SolidScheduler stores your scheduling data in a Solid Pod — a personal data store you control.

### Hosted providers (easiest)

Create a free account at one of these providers and set the `DEFAULT_SOLID_IDP` in `.env`:

| Provider | IDP URL | Notes |
|---|---|---|
| [Inrupt PodSpaces](https://start.inrupt.com) | `https://login.inrupt.com` | Default, most mature |
| [solidcommunity.net](https://solidcommunity.net) | `https://solidcommunity.net` | Community-run |

### Self-hosted Community Solid Server

If you want full control, run your own Solid server:

```bash
docker run -p 3000:3000 -v solid-data:/data solidproject/community-server
```

Then set:
```
DEFAULT_SOLID_IDP=http://localhost:3000
```

See the [Community Solid Server docs](https://communitysolidserver.github.io/CommunitySolidServer/) for production configuration.

## Email (SMTP)

SolidScheduler sends booking confirmations and cancellation notices via SMTP. Any SMTP provider works.

### Configuration

Set these in `.env`:

```
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=true
SMTP_USER=your-email@example.com
SMTP_PASS=your-app-password
SMTP_FROM=noreply@scheduler.example.com
```

### Common providers

| Provider | Host | Port | Notes |
|---|---|---|---|
| Your own mailserver | `localhost` or IP | 25/587 | No auth needed if on same network |
| Gmail | `smtp.gmail.com` | 587 | Requires App Password |
| Amazon SES | `email-smtp.region.amazonaws.com` | 587 | Requires IAM credentials |
| Mailgun | `smtp.mailgun.org` | 587 | — |
| Resend | `smtp.resend.com` | 465 | — |

Email is optional — if SMTP is not configured, bookings still work but no notifications are sent.

## CalDAV Calendar Sync (Optional)

Sync bookings to an external CalDAV calendar so they appear in your calendar app alongside everything else.

### Configuration

Set these in `.env`:

```
CALDAV_ENABLED=true
CALDAV_SERVER_URL=https://your-nextcloud.com/remote.php/dav/calendars/USERNAME/CALENDAR_NAME/
CALDAV_USERNAME=your-username
CALDAV_PASSWORD=your-app-password
CALDAV_CALENDAR_NAME=SolidScheduler
```

### Nextcloud setup (~5 minutes)

1. In Nextcloud, create a new calendar called "SolidScheduler" (or any name you like).
2. Generate an app password: **Settings > Security > Devices & sessions > Create new app password**.
3. Your CalDAV URL is:
   ```
   https://your-nextcloud.com/remote.php/dav/calendars/YOUR_USERNAME/solidscheduler/
   ```
   (The calendar name in the URL is lowercase with no spaces.)
4. Set the env vars above and restart:
   ```bash
   docker compose down && docker compose up -d
   ```

### Other CalDAV servers

| Server | CalDAV URL format |
|---|---|
| Nextcloud | `https://host/remote.php/dav/calendars/USER/CALENDAR/` |
| Radicale | `https://host/USER/CALENDAR.ics/` |
| Baikal | `https://host/dav.php/calendars/USER/CALENDAR/` |
| Google Calendar | Not supported (Google uses a proprietary API, not standard CalDAV) |

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `production` | Set to `production` for self-hosting |
| `BASE_URL` | Yes | — | Public URL of your instance |
| `FRONTEND_URL` | Yes | — | Usually same as BASE_URL |
| `SESSION_SECRET` | Yes | — | 32+ character random string |
| `DOMAIN` | Caddy only | — | Your domain (used by Caddy for auto-HTTPS) |
| `FRONTEND_PORT` | No | `0.0.0.0:80` | Frontend port binding; set to `127.0.0.1:3000` behind a reverse proxy |
| `REDIS_URL` | No | `redis://redis:6379` | Redis connection string |
| `DEFAULT_SOLID_IDP` | No | `https://login.inrupt.com` | Solid identity provider URL |
| `SMTP_HOST` | No | `127.0.0.1` | SMTP server hostname |
| `SMTP_PORT` | No | `587` | SMTP server port |
| `SMTP_SECURE` | No | `true` | Use TLS |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `SMTP_FROM` | No | — | Sender email address |
| `CALDAV_ENABLED` | No | `false` | Enable CalDAV calendar sync |
| `CALDAV_SERVER_URL` | No | — | CalDAV server URL |
| `CALDAV_USERNAME` | No | — | CalDAV username |
| `CALDAV_PASSWORD` | No | — | CalDAV password |
| `CALDAV_CALENDAR_NAME` | No | — | Calendar name on the CalDAV server |

## Updating

```bash
cd solid-scheduler
git pull
docker compose down
docker compose up -d --build
```

The `--build` flag ensures the frontend and backend are rebuilt with the latest code.

## Troubleshooting

### Frontend shows a blank page

Make sure `docker compose up -d` finished without errors. The frontend is built inside Docker during the first `docker compose up` — this can take a minute or two on the first run. Check logs with `docker compose logs frontend`.

### Solid login fails

Verify that `BASE_URL` matches the URL you are accessing the app from (including `https://`). Solid OIDC redirects will fail if there is a mismatch.

### Emails not sending

Check your SMTP credentials and that your SMTP provider has not blocked the server IP. You can test the configuration by checking the backend logs: `docker compose logs backend`.

### Redis connection refused

If Redis fails to start, the backend falls back to in-memory sessions (fine for single-instance deployments, but sessions will not survive a restart).
