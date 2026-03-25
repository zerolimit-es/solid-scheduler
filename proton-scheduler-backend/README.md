# ProtonScheduler Backend

A **Calendly-like scheduling application** built on [Solid](https://solidproject.org/) using [Inrupt's SDK](https://docs.inrupt.com/developer-tools/javascript/client-libraries/). Designed for privacy-first users who want to own their data.

## 🌟 Features

- **Decentralized Data Storage**: All your data lives in your Solid Pod
- **Solid-OIDC Authentication**: Log in with any Solid Identity Provider
- **Privacy-First**: No centralized data collection
- **Recurring Events**: Full iCalendar RRULE support (daily, weekly, monthly, yearly)
- **Calendar Integration**: Standard ICS files for any calendar app, SMTP via any provider
- **Public Booking Pages**: Share your availability without exposing private data
- **Email Notifications**: Confirmations and cancellations via SMTP

## 🔄 Recurring Events Support

ProtonScheduler supports full iCalendar RRULE specification:

### Frequencies
- **DAILY** - Every day or every N days
- **WEEKLY** - Every week on specific days (supports BYDAY: MO, TU, WE, TH, FR, SA, SU)
- **MONTHLY** - Every month on specific day
- **YEARLY** - Every year on specific date

### API Examples

```javascript
// Create a weekly recurring meeting (Mon, Wed, Fri for 10 occurrences)
POST /api/bookings
{
  "start": "2025-02-10T10:00:00Z",
  "end": "2025-02-10T10:30:00Z",
  "attendee": { "name": "Alex", "email": "alex@example.com" },
  "recurrence": {
    "frequency": "WEEKLY",
    "byDay": ["MO", "WE", "FR"],
    "count": 10
  }
}

// Create daily standup until a date
POST /api/bookings
{
  "start": "2025-02-10T09:00:00Z",
  "end": "2025-02-10T09:15:00Z",
  "attendee": { "name": "Team", "email": "team@example.com" },
  "recurrence": {
    "frequency": "DAILY",
    "until": "2025-03-31T09:00:00Z"
  }
}

// Cancel single occurrence
DELETE /api/bookings/:id
{
  "scope": "single",
  "occurrenceDate": "2025-02-12T10:00:00Z"
}

// Cancel entire series
DELETE /api/bookings/:id
{ "scope": "all" }

// Get expanded occurrences for calendar display
GET /api/bookings/expanded?from=2025-02-01&to=2025-02-28
```

### Recurrence Presets
```
GET /api/bookings/presets
```

Returns preset options: none, daily, weekdays, weekly, biweekly, monthly, yearly

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   ProtonScheduler Backend                        │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │   Express   │ │ Solid Auth  │ │   Email     │               │
│  │   Server    │ │  Middleware │ │   Service   │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Solid Pod     │  │  Solid Identity │  │  Proton Bridge  │
│  (User's Data)  │  │    Provider     │  │     (SMTP)      │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## 📁 Project Structure

```
proton-scheduler-backend/
├── src/
│   ├── config/
│   │   └── index.js         # Configuration management
│   ├── middleware/
│   │   └── auth.js          # Solid-OIDC authentication
│   ├── routes/
│   │   ├── auth.js          # Login/logout endpoints
│   │   ├── availability.js  # Availability management
│   │   ├── bookings.js      # Booking CRUD operations
│   │   └── public.js        # Public booking pages
│   ├── services/
│   │   ├── solid.js         # Solid Pod operations
│   │   ├── calendar.js      # Scheduling logic
│   │   └── email.js         # Email notifications
│   ├── utils/
│   │   ├── rdf.js           # RDF vocabularies
│   │   └── ics.js           # ICS file generation
│   └── server.js            # Express app entry point
├── .env.example             # Environment template
├── package.json
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- A Solid Pod account (get one at [Inrupt PodSpaces](https://start.inrupt.com/))
- (Optional) Proton Bridge for email notifications

### Installation

```bash
# Clone and install
cd proton-scheduler-backend
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Start server
npm start
```

### Development

```bash
npm run dev  # Starts with file watching
```

## ⚙️ Configuration

Edit `.env` file:

```env
# Server
PORT=3001
BASE_URL=http://localhost:3001
FRONTEND_URL=http://localhost:3000

# Session (generate a secure random string!)
SESSION_SECRET=your-super-secret-key

# Solid Identity Provider
DEFAULT_SOLID_IDP=https://login.inrupt.com

# Email (Proton Bridge)
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_USER=your-proton-email@proton.me
SMTP_PASS=your-bridge-password
```

## 📡 API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/login` | Start Solid OIDC login |
| GET | `/api/auth/callback` | OAuth callback |
| GET | `/api/auth/status` | Check auth status |
| POST | `/api/auth/logout` | End session |
| GET | `/api/auth/providers` | List identity providers |

### Availability

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/availability` | Get your settings |
| PUT | `/api/availability` | Update settings |
| GET | `/api/availability/slots?date=YYYY-MM-DD` | Get available slots |
| GET | `/api/availability/dates?year=&month=` | Get available dates |
| POST | `/api/availability/public` | Create public booking page |

### Bookings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bookings` | List bookings |
| POST | `/api/bookings` | Create booking |
| GET | `/api/bookings/upcoming` | Get upcoming |
| GET | `/api/bookings/stats` | Get statistics |
| GET | `/api/bookings/:id` | Get specific booking |
| DELETE | `/api/bookings/:id` | Cancel booking |
| GET | `/api/bookings/:id/ics` | Download ICS file |

### Public Booking (No Auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/public/:slug` | Get public page info |
| GET | `/api/public/:slug/dates` | Get available dates |
| GET | `/api/public/:slug/slots` | Get available slots |
| POST | `/api/public/:slug/book` | Create booking |

## 📊 Data Model

Scheduling data is stored in your Solid Pod as RDF and synced to the encrypted server database for fast access:

### Availability Settings
```turtle
@prefix sched: <https://vocab.protonscheduler.app/ns#> .
@prefix schema: <http://schema.org/> .

<#settings> a sched:AvailabilitySettings ;
    schema:name "Your Name" ;
    schema:email "you@proton.me" ;
    sched:eventDuration 30 ;
    sched:timezone "America/New_York" ;
    sched:bookingSlug "your-slug" .

<#monday> a sched:DayAvailability ;
    sched:dayOfWeek sched:Monday ;
    sched:isEnabled true ;
    sched:startTime "09:00" ;
    sched:endTime "17:00" .
```

### Booking
```turtle
<#event> a sched:Booking, schema:Event ;
    schema:name "Meeting with Alex" ;
    schema:startDate "2025-02-05T10:00:00Z"^^xsd:dateTime ;
    schema:endDate "2025-02-05T10:30:00Z"^^xsd:dateTime ;
    schema:eventStatus schema:EventConfirmed ;
    sched:bookedBy "Alex Chen" ;
    sched:bookedByEmail "alex@example.com" .
```

## 🔐 Authentication Flow

1. User clicks "Login with Solid"
2. Redirect to chosen Identity Provider (e.g., `login.inrupt.com`)
3. User authenticates with IDP
4. IDP redirects back to `/api/auth/callback`
5. Backend stores session, returns to frontend
6. All subsequent API calls use authenticated `fetch()`

## 📧 Email Setup with Proton Bridge

1. Install [Proton Bridge](https://proton.me/mail/bridge)
2. Log in with your Proton account
3. Get SMTP credentials from Bridge settings
4. Configure in `.env`:
   ```env
   SMTP_HOST=127.0.0.1
   SMTP_PORT=1025
   SMTP_USER=your-proton-email@proton.me
   SMTP_PASS=bridge-generated-password
   ```

## 🔗 Solid Pod Paths

The backend creates this structure in your Pod:

```
/proton-scheduler/
├── availability.ttl      # Your availability settings
├── public-profile.ttl    # Public booking page info
└── bookings/
    ├── booking-xxx.ttl   # Individual bookings
    └── booking-yyy.ttl
```

## 🧪 Testing

```bash
# Check if server is running
curl http://localhost:3001/health

# View API documentation
curl http://localhost:3001/api/docs

# Check auth status
curl http://localhost:3001/api/auth/status
```

## 🛣️ Roadmap

- [ ] Recurring availability patterns
- [ ] Team scheduling
- [x] CalDAV sync (Nextcloud, Radicale, Google Calendar, iCloud)
- [ ] Webhook notifications
- [ ] Mobile app
- [ ] Self-hosted Solid server integration

## 📚 Resources

- [Solid Project](https://solidproject.org/)
- [Inrupt Documentation](https://docs.inrupt.com/)
- [Solid-OIDC Spec](https://solid.github.io/solid-oidc/)
- [Proton Bridge](https://proton.me/mail/bridge)

## 📄 License

MIT

---

Built with ❤️ for privacy advocates and Solid enthusiasts.
