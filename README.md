# MatchSet Backend

Dedicated Express API for MatchSet. The frontend remains in [olexxee141-oss/matchset](https://github.com/olexxee141-oss/matchset).

## Responsibilities
- REST API for standalone player arrangements and community matches.
- PostgreSQL persistence through Neon.
- Input validation, organiser/result token checks, team distribution, winner-stays rotation, and leaderboard calculation.

## Runtime
- Node.js 20+
- TypeScript, Express, PostgreSQL (`pg`), Zod
- Deploy as a Node web service with build command `npm install && npm run build` and start command `npm start`.

## Environment
Copy `.env.example` to `.env` locally. Set:
- `DATABASE_URL`: Neon pooled connection string with SSL.
- `FRONTEND_ORIGIN`: exact frontend origin (comma-separated if multiple origins are required).
- `PORT`: supplied by most hosting platforms; defaults to 4000.
- `NODE_ENV`: set to `production` by the host.

Never commit real credentials. The API does not execute database DDL at startup. Existing Neon production tables are retained and managed separately.

## API
See [docs/api-contract.md](docs/api-contract.md) for the full v1 route and payload contract. It intentionally matches the current frontend API.

## Admins and tournaments
Community owners can promote roster members to Admin. Admins receive a private access link and can create tournaments and move teams between groups. Only owners can manage the roster or roles. Role changes are audited, and demotion revokes the admin token. Because MatchSet currently has no user accounts, admin access is represented by a private bearer link; anyone who obtains that link can act as that admin until the owner revokes access.

Before deploying the new API, apply [migration 001](docs/migrations/001_admin_tournament_grouping.sql) and [migration 002](docs/migrations/002_winner_stays_rotation.sql) to the existing Neon database, in order. [Migration 003](docs/migrations/003_shared_identity.sql) is the reviewed schema foundation for passkeys, recovery codes, sessions, account-to-membership claims, and duplicate community display names. It is not yet approved for production application; test it on a disposable Neon branch and review backup/rollback steps first. The API never runs production DDL automatically.

## Winner-stays match rotation
New community matches start with Set 1 vs Set 2. A win keeps the winning team on the pitch and moves the losing team to the back of the queue; a draw moves both teams to the back and brings in the next two. Every game is recorded, including draws. Organisers configure a 1–5 goal target and a 1–60 minute timer per rotation game. Goals record the scoring team, scorer and optional assister; reaching the target ends the game automatically. Timer expiry awards the win to the higher-scoring team or records a draw when tied. Timer timestamps, goal events, scores and queue state are stored together in `community_matches.rotation_state` JSONB. Organisers can pause/resume the timer and undo the latest completed game.

## Offline support — protocol planned, not implemented

The backend must support safe replay of queued organiser operations before the frontend enables offline writes. The implementation has not started. The design requires stable operation IDs, atomic idempotency receipts, monotonic session versions, ordered event validation, transactional rotation-state updates, explicit conflict responses, and a defensible offline-timer policy.

- [Backend offline protocol and implementation gates](docs/offline-support.md)
- [Frontend offline product and IndexedDB plan](https://github.com/olexxee141-oss/matchset/blob/main/docs/offline-support.md)

The existing `rotation_state` JSONB is the current match-state store, but it must not be assumed to provide durable request idempotency by itself. Any new persistence design must be additive, tested on a disposable Neon branch, and approved before production migration. The API must remain free of automatic DDL at startup. Offline results remain provisional until accepted by the server; first release assumes one controlling organiser device per match session.

## Local development
```bash
npm install
cp .env.example .env
npm run dev
```

## Verification
```bash
npm run typecheck
npm test
npm run build
```

CI runs all three checks on pushes and pull requests to `main`.
