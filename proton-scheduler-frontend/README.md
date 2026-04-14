# SolidScheduler Frontend

A React frontend for SolidScheduler, built with Vite and Tailwind CSS v4.

## Features

- **Solid-OIDC authentication** — login with any Solid Identity Provider
- **Dashboard** — view stats, upcoming meetings, manage availability
- **Public booking page** — interactive calendar with time slot selection
- **Recurring events** — daily, weekly, monthly, yearly recurrence
- **Passkey MFA** — WebAuthn second factor support

## Quick Start

```bash
cd proton-scheduler-frontend
npm install
npm run dev    # http://localhost:3000
```

Requires the backend running on port 3001.

## Production Build

```bash
npm run build
npm run preview
```

## Project Structure

```
proton-scheduler-frontend/
├── src/
│   ├── App.jsx                    # Main application
│   ├── main.jsx                   # Entry point
│   ├── hooks/
│   │   ├── useAuth.js             # Solid auth hook
│   │   └── useBookings.js         # Booking flow state
│   ├── services/
│   │   ├── api.js                 # API client
│   │   └── useTheme.js            # Light/dark theme
│   ├── styles/
│   │   ├── tokens.css             # Design tokens
│   │   ├── tailwind.css           # Tailwind v4 theme
│   │   └── app.css                # Component styles
│   ├── utils/
│   │   ├── webid.js               # WebID parsing
│   │   └── branding.js            # CSS variable application
│   └── components/
│       ├── booking/               # BookingView, BookingForm, ConfirmationView
│       ├── common/                # Icons, PasskeyChallenge, TimezoneSearch
│       ├── dashboard/             # DashboardView
│       └── layout/                # Header, LoginScreen
├── index.html
├── vite.config.js
├── postcss.config.js
└── package.json
```

## Configuration

The Vite dev server proxies `/api` requests to the backend (port 3001). No `.env` needed for development.

## License

MIT
