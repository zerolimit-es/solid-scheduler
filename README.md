# ProtonScheduler

> Privacy-first scheduling built on Solid Pods. The open-source Calendly alternative.

Your calendar data belongs to you. ProtonScheduler stores scheduling data in your personal [Solid Pod](https://solidproject.org/) — you own your data, always.

## Features

- **Solid Pod storage** — Your Pod is the source of truth for all scheduling data
- **Passkey MFA** — Optional WebAuthn second factor (Touch ID, Windows Hello, YubiKey)
- **Persistent sessions** — Redis-backed sessions survive server restarts
- **Public booking page** — Share a link for others to book time with you
- **Email notifications** — Booking confirmations and organizer alerts via SMTP
- **ICS export** — Download .ics calendar files for any booking
- **Self-hosted** — Run on your own infrastructure, MIT licensed

## Quick Start

```bash
git clone https://github.com/zerolimit-es/proton-scheduler.git
cd proton-scheduler

# Install dependencies
cd proton-scheduler-backend && npm install && cd ..
cd proton-scheduler-frontend && npm install && cd ..

# Configure
cp .env.example .env
# Edit .env with your settings

# Start development servers
# Terminal 1 — Backend
cd proton-scheduler-backend && npm run dev

# Terminal 2 — Frontend
cd proton-scheduler-frontend && npm run dev
```

Or with Docker:

```bash
make dev-up   # Start backend + Redis
make dev      # Start frontend dev server (Vite)
```

## Project Structure

```
proton-scheduler/
├── proton-scheduler-backend/     # Express API (Node 20, ESM)
│   ├── src/
│   │   ├── config/               # Configuration
│   │   ├── middleware/           # auth, validate (Zod), rateLimit
│   │   ├── routes/               # auth, availability, bookings, public
│   │   ├── services/             # solid, calendar, email
│   │   └── utils/                # ics, recurrence, rdf
│   └── package.json
│
├── proton-scheduler-frontend/    # React frontend (Vite + Tailwind v4)
│   ├── src/
│   │   ├── App.jsx               # Main application
│   │   ├── hooks/                # useAuth, useBookings
│   │   ├── services/api.js       # API client
│   │   ├── styles/               # app.css, tokens.css
│   │   └── components/
│   │       ├── booking/          # BookingView, BookingForm, ConfirmationView
│   │       ├── common/           # Icons, PasskeyChallenge, TimezoneSearch
│   │       ├── dashboard/        # DashboardView
│   │       └── layout/           # Header, LoginScreen
│   └── package.json
│
├── docker/nginx/                 # Nginx config
├── docker-compose.yml            # Production
├── docker-compose.dev.yml        # Development
├── Makefile
├── CONTRIBUTING.md
└── README.md
```

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 LTS, Express (ESM) |
| Frontend | React, Vite, Tailwind CSS v4 |
| Sessions | Redis (write-through + in-memory fallback) |
| Auth | Solid OIDC + optional WebAuthn/Passkey MFA |
| Email | Any SMTP provider |
| Containers | Docker + Docker Compose |

## Environment Variables

See `.env.example` for all options. Minimum for development:

```bash
NODE_ENV=development
PORT=3001
BASE_URL=http://localhost:3001
FRONTEND_URL=http://localhost:3000
SESSION_SECRET=any-random-string-for-dev
DEFAULT_SOLID_IDP=https://login.inrupt.com
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, commit style, and PR process.

## License

MIT — see [LICENSE](LICENSE).

## Built by

[Zero Limit (SASU)](https://zerolimit.es) — Paris, France
