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

Two things make this work:

1. Your proxy must send `X-Forwarded-Proto: https` and `X-Forwarded-For` (Traefik, Caddy and HAProxy's `option forwardfor` + `http-request set-header X-Forwarded-Proto https` do). The frontend container passes them on to the backend, which only sets its session cookie when it sees `https`. Without the header, signing in fails.
2. Set `TRUST_PROXY=2` in `.env`. Requests now pass through two proxies (yours, then the frontend container) before reaching the backend. With the default of `1`, the backend takes your proxy's address for the visitor's, and all visitors share one rate limit.

```env
BASE_URL=https://scheduler.example.com
FRONTEND_URL=https://scheduler.example.com
FRONTEND_PORT=127.0.0.1:3000
TRUST_PROXY=2
```

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
SMTP_SECURE=false
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

Copy your bookings to an external CalDAV calendar so they appear in your calendar app alongside everything else.

The sync is one way. Each new booking on your booking page is added to the calendar, and cancelling a booking removes it. Changes made in the calendar app are not read back. Cancelling a single occurrence of a recurring booking leaves the series in the calendar.

It copies **one account's** bookings: the booking page named by `CALDAV_BOOKING_SLUG`. On an instance with several accounts, everyone else's bookings, attendee names and email addresses included, stay out of your calendar. If `CALDAV_BOOKING_SLUG` is empty, nothing is synced.

If the CalDAV server is down, bookings still go through; the backend logs a `[CalDAV]` warning for each booking it couldn't copy.

### Configuration

Set these in `.env`:

```
CALDAV_ENABLED=true
CALDAV_SERVER_URL=https://your-nextcloud.com/remote.php/dav/calendars/USERNAME/CALENDAR_NAME/
CALDAV_USERNAME=your-username
CALDAV_PASSWORD=your-app-password
CALDAV_BOOKING_SLUG=your-booking-slug
```

- `CALDAV_SERVER_URL` is the URL of the calendar itself (a CalDAV collection), not the server's root.
- `CALDAV_BOOKING_SLUG` is the last part of your booking link: for `https://your-domain.com/book/alice`, it's `alice`.
- Use `https://`. A plain `http://` URL works (useful for a server on your own network), but sends the password unencrypted; the backend logs a warning.

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
| `DB_PATH` | No | `/data/solid-scheduler.db` | SQLite database file; set by the Docker image, keep it on the `/data` volume |
| `TRUST_PROXY` | No | `1` | Number of reverse proxies in front of the backend. Leave at `1` for the bundled Caddy/nginx setups; set `2` with your own proxy in front of the frontend container (Option C) |
| `REDIS_URL` | No | `redis://redis:6379` | Redis connection string |
| `DEFAULT_SOLID_IDP` | No | `https://login.inrupt.com` | Solid identity provider URL |
| `SMTP_HOST` | No | `127.0.0.1` | SMTP server hostname |
| `SMTP_PORT` | No | `587` | SMTP server port |
| `SMTP_SECURE` | No | `false` | `true` for port 465 (TLS from the start); `false` for port 587 (STARTTLS). `true` with port 587 is treated as STARTTLS with TLS required |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `SMTP_FROM` | No | — | Sender email address |
| `SMTP_FROM_NAME` | No | `SolidScheduler` | Sender name shown in mail clients |
| `ORGANIZER_NAME` | No | — | Name used on bookings for accounts that have not saved one in their settings |
| `ORGANIZER_EMAIL` | No | — | Where booking notifications go for accounts that have not saved an email |
| `ALLOW_PRIVATE_POD_HOSTS` | No | `false` | Allow users to set a Pod URL on a private network address (a Pod server on your own LAN) |
| `CALDAV_ENABLED` | No | `false` | Enable CalDAV calendar sync |
| `CALDAV_SERVER_URL` | With CalDAV | — | URL of the calendar (CalDAV collection) to copy bookings to |
| `CALDAV_USERNAME` | With CalDAV | — | CalDAV username |
| `CALDAV_PASSWORD` | With CalDAV | — | CalDAV password (use an app password where possible) |
| `CALDAV_BOOKING_SLUG` | With CalDAV | — | Booking page whose bookings are copied; other accounts' bookings are never sent |

## Data and Backups

Accounts, bookings waiting to be synced, passkeys and blocked time are kept in a SQLite database at `/data/solid-scheduler.db` inside the backend container, on the `backend-data` Docker volume. The volume survives `docker compose down`, rebuilds and upgrades. It is deleted by `docker compose down -v` (and by `make clean`).

To back it up:

```bash
docker compose exec backend sh -c 'cat /data/solid-scheduler.db' > solid-scheduler-backup.db
```

For a consistent copy, stop the backend first (`docker compose stop backend`) or take the backup at a quiet moment.

### Upgrading from a version without the data volume

Earlier versions kept the database inside the container itself (`/app/src/data/`), where it was lost whenever the container was recreated. **Before** you rebuild, copy it out of the running container and into the new volume:

```bash
docker compose stop backend
docker cp solidscheduler-backend:/app/src/data ./solid-scheduler-data
git pull
docker compose up -d --build
docker compose stop backend
docker cp ./solid-scheduler-data/. solidscheduler-backend:/data/
docker compose start backend
```

If `docker cp` reports that `/app/src/data` does not exist, there is nothing to migrate.

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

If you run your own reverse proxy in front of the frontend container (Option C) and signing in returns you to the login screen, the session cookie is not being set: check that your proxy sends `X-Forwarded-Proto: https`.

### Emails not sending

Check your SMTP credentials and that your SMTP provider has not blocked the server IP. You can test the configuration by checking the backend logs: `docker compose logs backend`.

### Redis connection refused

If Redis fails to start, the backend falls back to in-memory sessions (fine for single-instance deployments, but sessions will not survive a restart).
