# davvn AIM

Real-time AIM-style chat server for the davvn bedroom site.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Server runs on `http://localhost:3001` by default.

## Architecture

- **Express + Socket.IO** for real-time messaging
- **SQLite** for chat history and user data
- **Moderation**: word filter, rate limiting, report system

## Events

### Client → Server
- `sign-on` — { screenName }
- `set-away` — { message } or null
- `send-message` — { to, text }
- `load-history` — { with }
- `report-user` — { screenName, messageId?, reason }

### Server → Client
- `sign-on-success` — { screenName, buddyList }
- `sign-on-error` — { message }
- `buddy-update` — { screenName, status, awayMessage? }
- `buddy-offline` — { screenName }
- `message` — { from, text, timestamp, id }
- `history` — { with, messages }
- `message-blocked` — { reason }
- `user-reported` — { success }

## Deploy

Works on Railway, Fly.io, Render, etc. Set `CORS_ORIGIN` to your production domain.
