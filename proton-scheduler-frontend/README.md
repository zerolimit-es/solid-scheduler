# ProtonScheduler Frontend

A **React frontend** for the ProtonScheduler Calendly-like application, built on **Solid/Inrupt** for privacy-first scheduling.

## 🌟 Features

- **Solid-OIDC Authentication** - Login with any Solid Identity Provider
- **Dashboard** - View stats, upcoming meetings, and manage availability
- **Calendar Booking** - Interactive calendar with time slot selection
- **Recurring Events** - Create daily, weekly, monthly, or yearly recurring meetings
- **Pod Integration** - All data stored in user's personal Solid Pod
- **ICS Download** - Export meetings to any calendar app (includes RRULE for recurring)
- **Settings** - Configure profile and availability

## 🏗️ Architecture

```
Frontend (React + Vite)
        │
        │  REST API (fetch with credentials)
        ▼
Backend (Express + Solid SDK)
        │
        │  Solid Protocol
        ▼
    Solid Pod (User's Data)
```

## 📁 Project Structure

```
proton-scheduler-frontend/
├── src/
│   ├── App.jsx              # Main application component
│   ├── main.jsx             # Entry point
│   └── services/
│       ├── api.js           # API client for backend
│       └── hooks.js         # React hooks for data fetching
├── index.html               # HTML template
├── vite.config.js           # Vite configuration
├── package.json
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Backend server running (see backend README)

### Installation

```bash
cd proton-scheduler-frontend
npm install
```

### Development

```bash
# Start development server
npm run dev

# Open http://localhost:3000
```

### Production Build

```bash
npm run build
npm run preview
```

## ⚙️ Configuration

Create a `.env` file:

```env
VITE_API_URL=http://localhost:3001
```

The Vite config also includes a proxy for `/api` routes during development.

## 🔐 Authentication Flow

1. **User clicks "Login with Solid"**
2. **Selects Identity Provider** (Inrupt, solidcommunity.net, etc.)
3. **Redirected to IDP** for authentication
4. **IDP redirects back** with auth tokens
5. **Backend establishes session** with cookies
6. **Frontend receives auth status** and loads user data

## 📡 API Integration

The frontend communicates with the backend via REST API:

```javascript
// Authentication
api.auth.getStatus()        // Check if logged in
api.auth.getLoginUrl(idp)   // Get login redirect URL
api.auth.logout()           // End session

// Availability (stored in Pod)
api.availability.get()           // Load from Pod
api.availability.update(data)    // Save to Pod
api.availability.getSlots(date)  // Get available times

// Bookings (stored in Pod)
api.bookings.list()              // List all bookings
api.bookings.create(data)        // Create new booking
api.bookings.cancel(id)          // Cancel booking
api.bookings.getIcsUrl(id)       // Get ICS download URL
```

## 🎨 UI Components

### Views

| View | Description |
|------|-------------|
| Login | Solid IDP selection and login |
| Dashboard | Stats, booking link, availability, upcoming meetings |
| Booking | Calendar and time slot selection |
| Form | Attendee details input |
| Confirmation | Success screen with ICS download |
| Settings | Profile and preferences |

### Key Features

- **Real-time availability** - Fetches slots from Pod
- **Loading states** - Shows spinners during API calls
- **Error handling** - Displays error banners
- **Responsive design** - Works on mobile and desktop

## 🎯 State Management

The app uses React's built-in state with custom hooks:

```javascript
// Auth state
const { user, isAuthenticated, login, logout } = useAuth();

// Availability data
const { availability, saveAvailability, toggleDay } = useAvailability();

// Bookings data
const { bookings, stats, createBooking, cancelBooking } = useBookings();
```

## 🧪 Testing the Integration

1. **Start the backend:**
   ```bash
   cd proton-scheduler-backend
   npm start
   ```

2. **Start the frontend:**
   ```bash
   cd proton-scheduler-frontend
   npm run dev
   ```

3. **Open http://localhost:3000**

4. **Click "Login with Solid"**

5. **Select your Identity Provider** (e.g., Inrupt PodSpaces)

6. **Authenticate with your Solid account**

7. **You should see the dashboard** with your Pod data

## 🐛 Troubleshooting

### CORS Issues
Make sure the backend has the frontend URL in its CORS config:
```javascript
cors({ origin: ['http://localhost:3000'], credentials: true })
```

### Session Not Persisting
Check that cookies are being sent:
- Backend: `credentials: true` in CORS
- Frontend: `credentials: 'include'` in fetch

### Pod Not Loading
Verify your Solid Pod is accessible and you have the correct permissions.

## 📚 Resources

- [Solid Project](https://solidproject.org/)
- [Inrupt Documentation](https://docs.inrupt.com/)
- [React Documentation](https://react.dev/)
- [Vite Documentation](https://vitejs.dev/)

## 📄 License

MIT

---

Built with ❤️ for privacy-first scheduling.
