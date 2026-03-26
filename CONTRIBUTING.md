# Contributing to ProtonScheduler

Thank you for considering contributing to ProtonScheduler. It's people like you that make privacy-first scheduling better for everyone.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Style Guides](#style-guides)
- [Community](#community)

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to [scheduler@zerolimit.es](mailto:scheduler@zerolimit.es).

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose (optional, for containerized development)
- Git
- A Solid Pod account (free at [Inrupt PodSpaces](https://start.inrupt.com) or [solidcommunity.net](https://solidcommunity.net))

### Quick Setup

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/zerolimit-es/solid-scheduler.git
cd proton-scheduler

# Install dependencies
cd proton-scheduler-backend && npm install && cd ..
cd proton-scheduler-frontend && npm install && cd ..

# Copy environment file
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

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the [existing issues](https://github.com/zerolimit-es/solid-scheduler/issues) to avoid duplicates.

When creating a bug report, include:

- Clear title describing the issue
- Steps to reproduce
- Expected behavior vs what actually happened
- Screenshots if applicable
- Environment details (OS, browser, Node version)

### Suggesting Features

Feature requests are welcome. Please:

1. Check if the feature has already been requested
2. Explain the use case and why it would benefit users
3. Consider if you would be willing to implement it

### Your First Code Contribution

Look for issues labeled:

- `good first issue` — great for newcomers
- `help wanted` — we would love help with these
- `documentation` — improve our docs

## Development Setup

### Project Structure

```
proton-scheduler/
├── proton-scheduler-backend/     # Node.js/Express API
│   ├── src/
│   │   ├── config/               # Configuration
│   │   ├── middleware/           # Express middleware (auth, validate, rateLimit)
│   │   ├── routes/               # API routes
│   │   ├── services/             # Business logic (solid, calendar, email)
│   │   └── utils/                # Utilities (ics, recurrence, rdf)
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
└── Makefile
```

### Running Tests

```bash
# Backend tests
cd proton-scheduler-backend
npm test

# Individual suites
node --test src/middleware/validate.test.js
node --test src/utils/ics.test.js
node --test src/utils/recurrence.test.js
```

### Environment Variables

See `.env.example` for all available options. Minimum required for development:

```bash
NODE_ENV=development
PORT=3001
BASE_URL=http://localhost:3001
FRONTEND_URL=http://localhost:3000
SESSION_SECRET=any-random-string-for-dev
DEFAULT_SOLID_IDP=https://login.inrupt.com
```

> **Warning:** Do not set `NODE_ENV=production` on HTTP — session cookies require HTTPS in production mode.

## Pull Request Process

### Before Submitting

1. Fork the repository
2. Create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```
3. Make your changes following the style guides below
4. Test your changes — run `npm test` in the backend
5. Commit with clear, descriptive messages

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:

| Type | Use for |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code restructuring (no behavior change) |
| `docs` | Documentation only |
| `chore` | Maintenance, dependencies |
| `test` | Adding or updating tests |
| `style` | Formatting only |

Examples:

```
feat(booking): add recurrence support for weekly meetings
fix(auth): handle expired Solid session tokens gracefully
refactor(dashboard): replace inline styles with CSS variables
chore(deps): upgrade tailwindcss to v4
```

### Submitting Your PR

1. Push your branch to your fork
2. Open a PR against `main` in the upstream repo
3. Fill out the PR description template (type of change, what changed, verification steps)
4. Link any related issues
5. Wait for CI checks to pass

### Review Process

- All PRs require at least one approval
- CI checks (build + tests) must pass
- Address review feedback and push fixup commits — squash before merge
- Keep PRs focused — one concern per PR

## Style Guides

### JavaScript / Node.js

- Use ES modules (`import`/`export`)
- Use `async`/`await` for asynchronous code
- Add JSDoc comments for exported functions
- Keep functions focused and small

### React / Frontend

- Use functional components with hooks
- Keep components focused — one responsibility per file
- Use CSS variables (`var(--theme-*)`) for theme-sensitive colors rather than hardcoded hex values
- Use Tailwind utility classes for layout; CSS variables via `style` prop for colors that need to respond to the theme

### Git

- Keep commits atomic
- Write clear commit messages
- Rebase to keep history clean

## Community

### Getting Help

- [GitHub Discussions](https://github.com/zerolimit-es/solid-scheduler/discussions) — Questions and ideas
- [GitHub Issues](https://github.com/zerolimit-es/solid-scheduler/issues) — Bug reports and feature requests
- Email: [scheduler@zerolimit.es](mailto:scheduler@zerolimit.es)

---

Thank you for contributing. Every bug report, feature request, documentation improvement, and code contribution helps make privacy-first scheduling better.
