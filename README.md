# StackPoker Backend

Backend for [StackPoker](https://github.com/camronjacobson/StackPoker_game), a real-time multiplayer poker app for iOS. Handles table management, game logic, chip balances, and all client communication over REST and WebSocket. Supports Texas Hold'em and Pot-Limit Omaha.

## Stack

- **Runtime:** Node.js + TypeScript
- **HTTP:** Express with JWT auth (access/refresh tokens, Apple Sign-In)
- **Real-time:** Socket.IO for game state, player actions, and chat
- **Database:** PostgreSQL via Prisma ORM
- **Cache:** Redis (Socket.IO adapter, session tracking)
- **Deployment:** Railway

## API surface

REST endpoints under `/api/`:

- `/auth` — register, login, Apple OAuth, token refresh
- `/tables` — create, join (by code), leave, top-up, close, invite
- `/chips` — balance, daily bonus, transfers, transaction history
- `/friends` — requests, search, block
- `/users` — quick-profile (stats + friendship status)
- `/cosmetics` — purchase, equip, inventory
- `/admin` — kick, ban, grant chips, reset table

WebSocket events handle the game itself: `join_table`, `player_action` (fold/check/call/raise/all-in), `leave_table`, `show_cards`, `table_chat`, and time extensions. The server pushes `game_state` snapshots (filtered per player), `hand_ended` results, and connection/disconnection notices.

Background sweepers run every 15 seconds to close idle tables and auto-leave disconnected players after a 90-second grace period. Chips are refunded to the user's balance in both cases.

## Local setup

```
cp .env.example .env
```

Fill in `DATABASE_URL`, `REDIS_URL`, and `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`. See `.env.example` for the full list. Then:

```
npm install
npx prisma migrate dev
npm run dev
```

## Tests

```
npm test
```

Tests cover the poker engine, hand evaluation, pot splitting, PLO rules, cosmetics, and chip balance consistency. They run with Jest and don't require a running database.
