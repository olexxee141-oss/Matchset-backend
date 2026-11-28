# API contract (v1)

All routes are prefixed with `/api`. Community read requests may include:
- `X-Community-Owner-Token`: identifies the community owner.
- `X-Community-Admin-Token`: identifies an appointed tournament admin.

## Health
- `GET /api/health` → `{ status: "ok", database: "connected" }`

## Standalone arrangements
- `POST /api/sessions` body `{ name, players, playersPerSet }` → `{ session, editToken }`.
- `GET /api/sessions/:slug` → `{ session }`.
- `PUT /api/sessions/:slug` body `{ name, players, playersPerSet, editToken }` → `{ session }`.

## Communities
- `POST /api/communities` body `{ name, creatorName }` → `{ community, member, ownerToken }`.
- `GET /api/communities/:slug` → `{ community, members, matches, leaderboard, tournaments, access }`.
- `POST /api/communities/:slug/members` body `{ name, ownerToken }` → `{ member }`. Only the community owner can manage the roster.
- `POST /api/communities/:slug/members/:memberId/admin` body `{ ownerToken }` → `{ role: "ADMIN", adminToken }`. Owner-only. The returned token is shown once and must be shared privately with the appointed member.
- `DELETE /api/communities/:slug/members/:memberId/admin` body `{ ownerToken }` → `{ role: "MEMBER" }`. Owner-only; revokes the member's admin token immediately.
- `POST /api/communities/:slug/tournaments` body `{ name, groups, ownerToken? }` → `{ tournaments }`. Owner or admin only. Each group contains teams; each team contains a name and community member IDs. Admin requests authenticate with `X-Community-Admin-Token`.
- `PUT /api/communities/:slug/tournaments/:tournamentId/groups` body `{ groups, ownerToken? }` → `{ tournaments }`. Owner or admin only. Replaces group assignments atomically.
- `POST /api/communities/:slug/matches` body `{ title, memberIds, playersPerTeam, createdByMemberId, ownerToken, goalsToWin?, durationMinutes? }` → `{ match, resultToken }`. Goal target defaults to 1 (range 1–5); each rotation game timer defaults to 10 minutes (range 1–60). Owner-only.
- `POST /api/communities/:slug/matches/:matchId/result` body `{ resultToken, winningTeamId }` → `{ match }` (legacy result endpoint).
- New community matches initialize a persistent winner-stays rotation in `match.rotationState`: `activeTeamIds`, `waitingTeamIds`, `games`, `status`, goal target, per-game goal events/score and server-authoritative timer timestamps.
- `POST /api/communities/:slug/matches/:matchId/rotation/goal` body `{ resultToken, teamId, scorerId, assisterId? }` → updated `{ match }`. Scorer and optional assister must belong to the active scoring team; self-assists are rejected. Reaching the goal target completes the game automatically.
- `POST /api/communities/:slug/matches/:matchId/rotation/timer` body `{ resultToken, action: PAUSE | RESUME | TICK }` → updated `{ match }`. The server stores timer timestamps in rotation JSONB; `TICK` completes an expired game using score (or draw when tied).
- `POST /api/communities/:slug/matches/:matchId/rotation/undo` body `{ resultToken }` → updated `{ match }`. Removes only the latest completed game and restores its pre-game lineup, score and timer.

Role changes are recorded in `community_role_audit`. Admins cannot manage the roster, appoint admins, create matches, record match results, or delete communities. Admin tokens are stored as hashes and are invalidated when an admin is demoted.

Validation errors return 400; missing resources 404; failed authorization 403; conflicts 409. Errors use `{ error }` JSON.

## Database migration
Apply `docs/migrations/001_admin_tournament_grouping.sql` and then `docs/migrations/002_winner_stays_rotation.sql` to the existing Neon production database before deploying this API version. Both migrations are additive and preserve existing community data. The API deliberately does not execute DDL at startup.
