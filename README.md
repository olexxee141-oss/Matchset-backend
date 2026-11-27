# MatchSet Backend

Dedicated Express API for MatchSet. The frontend remains in the `olexxee141-oss/matchset` repository.

## Responsibilities
- REST API for standalone player arrangements and community matches.
- PostgreSQL persistence through Neon.
- Input validation, organiser/result token checks, and leaderboard calculation.

## Runtime
- Node.js 20+
- TypeScript, Express, PostgreSQL (`pg`), Zod
- Deploy as a persistent Node service (not a Vercel static build).

## Environment
Copy `.env.example` to `.env` for local development. Set `DATABASE_URL` to the Neon pooled connection string and `FRONTEND_ORIGIN` to the deployed frontend origin.

## API
The initial extraction preserves the existing frontend contract. See `docs/api-contract.md`.

## Database
Production tables already exist in Neon. Application startup must not execute DDL. Schema changes will be handled as explicit, reviewed migrations.
