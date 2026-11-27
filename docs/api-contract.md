# API contract (v1)

All routes are prefixed with `/api` and preserve the existing MatchSet frontend JSON contract.

## Health
- `GET /api/health` → `{ status: "ok", database: "connected" }`

## Standalone arrangements
- `POST /api/sessions` body `{ name, players, playersPerSet }` → `{ session, editToken }`.
- `GET /api/sessions/:slug` → `{ session }`.
- `PUT /api/sessions/:slug` body `{ name, players, playersPerSet, editToken }` → `{ session }`.

## Communities
- `POST /api/communities` body `{ name, creatorName }` → `{ community, member, ownerToken }`.
- `GET /api/communities/:slug` → `{ community, members, matches, leaderboard }`.
- `POST /api/communities/:slug/members` body `{ name }` → `{ member }`.
- `POST /api/communities/:slug/matches` body `{ title, memberIds, playersPerTeam, createdByMemberId, ownerToken }` → `{ match, resultToken }`.
- `POST /api/communities/:slug/matches/:matchId/result` body `{ resultToken, winningTeamId }` → `{ match }`.

Validation errors return 400; missing resources 404; failed token checks 403; conflicts 409. Errors use `{ error }` JSON.

CORS is restricted to comma-separated `FRONTEND_ORIGIN` values. Token hashing and constant-time comparison are retained. The API performs no DDL at startup or during requests; Neon schema changes remain separate, explicit operations.
