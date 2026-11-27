# MatchSet Backend

Dedicated Express API for MatchSet. The frontend remains in [olexxee141-oss/matchset](https://github.com/olexxee141-oss/matchset).

## Responsibilities
- REST API for standalone player arrangements and community matches.
- PostgreSQL persistence through Neon.
- Input validation, organiser/result token checks, team distribution, and leaderboard calculation.

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

Before deploying the new API, apply [migration 001](docs/migrations/001_admin_tournament_grouping.sql) to the existing Neon database. The API never runs production DDL automatically.

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
