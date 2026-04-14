# SolidScheduler Backend

A privacy-first scheduling API built on [Solid](https://solidproject.org/) using [Inrupt's SDK](https://docs.inrupt.com/developer-tools/javascript/client-libraries/).

## Features

- **Decentralized data** — scheduling data lives in your Solid Pod
- **Solid-OIDC authentication** — login with any Solid Identity Provider
- **Passkey MFA** — optional WebAuthn second factor
- **Recurring events** — full iCalendar RRULE support (daily, weekly, monthly, yearly)
- **Public booking pages** — share availability without exposing private data
- **Email notifications** — confirmations and cancellations via any SMTP provider
- **ICS export** — standard calendar files for any app

## Quick Start

```bash
cd proton-scheduler-backend
cp .env.example .env   # Edit with your settings
npm install
npm run dev            # Start with file watching
```

## Configuration

Edit `.env`:

```env
PORT=3001
BASE_URL=http://localhost:3001
FRONTEND_URL=http://localhost:3000
SESSION_SECRET=your-super-secret-key    # openssl rand -hex 32
DEFAULT_SOLID_IDP=https://login.inrupt.com

# Email (any SMTP provider)
SMTP_HOST=127.0.0.1
SMTP_PORT=587
SMTP_USER=your-email
SMTP_PASS=your-password
```

## Project Structure

```
proton-scheduler-backend/
├── src/
│   ├── config/index.js        # Configuration
│   ├── middleware/
│   │   ├── auth.js            # Solid-OIDC session middleware
│   │   ├── validate.js        # Zod schema validation
│   │   └── rateLimit.js       # Rate limiting
│   ├── routes/
│   │   ├── auth.js            # Login/logout endpoints
│   │   ├── passkey.js         # WebAuthn/MFA registration & verification
│   │   ├── availability.js    # Availability settings
│   │   ├── bookings.js        # Booking CRUD
│   │   ├── public.js          # Public booking page (no auth)
│   │   └── calendar-feed.js   # ICS calendar export
│   ├── services/
│   │   ├── solid.js           # Solid Pod operations
│   │   ├── calendar.js        # Scheduling/recurrence logic
│   │   ├── email.js           # SMTP email sending
│   │   └── redis.js           # Session storage
│   ├── utils/
│   │   ├── ics.js             # ICS file generation
│   │   ├── recurrence.js      # Recurrence rule parsing
│   │   ├── rrule.js           # RRULE expansion
│   │   ├── rdf.js             # RDF vocabularies
│   │   └── webid.js           # WebID parsing
│   ├── cloud/
│   │   ├── config/tiers.js    # Feature limits (all unlocked in self-hosted)
│   │   ├── models/            # SQLite data layer + migrations
│   │   └── services/          # Email templates, Pod sync
│   └── server.js              # Express app entry point
├── tests/
│   ├── smoke-test.sh          # HTTP endpoint smoke test
│   └── smoke-test.ps1         # PowerShell variant
├── .env.example
└── package.json
```

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/login` | Start Solid OIDC login |
| GET | `/api/auth/callback` | OAuth callback |
| GET | `/api/auth/status` | Check auth status |
| POST | `/api/auth/logout` | End session |

### Availability

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/availability` | Get settings |
| PUT | `/api/availability` | Update settings |
| GET | `/api/availability/slots?date=YYYY-MM-DD` | Get available slots |

### Bookings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bookings` | List bookings |
| POST | `/api/bookings` | Create booking |
| DELETE | `/api/bookings/:id` | Cancel booking |

### Public Booking (No Auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/public/:slug` | Get public page info |
| GET | `/api/public/:slug/slots` | Get available slots |
| POST | `/api/public/:slug/book` | Create booking |

## Testing

```bash
npm test                                    # All tests
node --test src/utils/ics.test.js          # Individual suite
./tests/smoke-test.sh http://localhost:3001 # HTTP smoke test
```

## License

MIT
