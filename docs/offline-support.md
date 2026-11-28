# MatchSet Offline Support — Backend Protocol

**Status:** Decision documented; implementation not started.  
**Scope:** Express API and Neon persistence in `olexxee141-oss/Matchset-backend`, coordinated with the [frontend plan](https://github.com/olexxee141-oss/matchset/blob/main/docs/offline-support.md).

## Purpose

The backend must accept safely queued operations from a temporarily disconnected organiser without duplicating goals, corrupting the winner-stays queue, or overwriting newer match state. A successful local write is provisional until the API acknowledges it.

This is a protocol design document, not a claim that these endpoints or database fields currently exist.

## Existing backend baseline

- Express + TypeScript + PostgreSQL (`pg`) + Zod, deployed as a Render web service.
- Neon PostgreSQL is the system of record.
- Community rotation state and game history are stored in `community_matches.rotation_state` JSONB.
- Existing rotation rules: initial Set 1 vs Set 2; winner stays and loser moves to queue tail; draw sends both active teams to queue tail and brings in the next two.
- Goal events include team, scorer, and optional assister. Goal target defaults to 1 and is configurable 1–5.
- Timer defaults to 10 minutes and is configurable 1–60. Timer expiry chooses the higher score or draw when tied.
- Pause/resume and undo latest completed game are supported.
- Migration 001 provides admin/tournament grouping; migration 002 adds the JSONB rotation state and index. These migrations are already part of the documented production baseline.
- The API must not execute DDL at startup. Existing Neon schema/data must be preserved.

## Required protocol

### Operation envelope

Every offline-capable mutation should be represented as an operation with:

| Field | Purpose |
|---|---|
| `operationId` | Client-generated UUID, stable across retries; unique within the system |
| `matchId` | Target community match |
| `sessionId` | Stable rotation-session identity |
| `clientSequence` | Strictly increasing sequence for this client/session |
| `expectedVersion` | Server session version last observed by the client |
| `type` | Explicit allow-listed event type |
| `payload` | Event-specific validated data |
| `clientCreatedAt` | Diagnostic timestamp only; never trusted as authoritative time |

The server derives the community and actor from the route and existing authorisation mechanism. Do not trust client-supplied actor IDs, community IDs that disagree with the route, or client timestamps as authority.

### Idempotency

- The same `operationId` and same canonical payload must return the original acknowledgement/result without applying the event twice.
- Reusing an `operationId` with a different payload must be rejected as an idempotency-key collision.
- A network timeout after commit must be safe: retrying the same operation cannot add a second goal, rotate the queue twice, or undo twice.
- Idempotency record and match-state mutation must commit atomically.
- Define retention/cleanup only after the required replay window is decided; never expire keys while clients may legitimately retry queued operations.

### Session versioning and event ordering

- Maintain a monotonically increasing server version for each rotation session.
- Each accepted operation checks `expectedVersion` and sequence/order constraints inside the same database transaction that mutates `rotation_state`.
- A stale version returns a conflict with the current authoritative version/state; it must not overwrite it.
- Duplicate operation IDs return their prior acknowledgement even if the caller's expected version is now stale.
- Validate event-specific invariants using the current locked state: active teams, queue order, scorer/assister membership, score target, timer state, completed-game state, and undo eligibility.
- Use row locking/transactional updates so concurrent requests cannot interleave partial rotations.

## Suggested API shape

The exact route should be finalised during implementation after reviewing current controllers, validators, and API conventions. Preferred direction:

- `POST /api/communities/:slug/matches/:matchId/rotation/events`
  - Accepts one ordered operation or a bounded ordered batch.
  - Returns per-operation accepted/duplicate/conflict/rejected status plus authoritative session version/state.
- Existing goal and timer routes may be retained as compatibility endpoints, but offline-capable clients should use one consistent idempotent protocol.
- Do not introduce a separate sync service or message broker for the first release.

Example response semantics (illustrative, not an existing contract):

- `accepted`: operation committed; includes new version and authoritative state.
- `duplicate`: same operation already committed; returns original acknowledgement.
- `conflict`: expected version or event order is stale; includes current state/version.
- `rejected`: operation violates a business rule; includes a stable error code and safe explanation.

## Event model

Start with a narrow allow-list:

- `MATCH_SESSION_STARTED` (only if match creation is included in offline scope).
- `GOAL_RECORDED` (team, scorer, optional assister).
- `TIMER_PAUSED`.
- `TIMER_RESUMED`.
- `GAME_EXPIRED` (provisional client observation; server applies the timer policy below).
- `GAME_COMPLETED` only for valid derived outcomes, not arbitrary client-supplied winners.
- `LATEST_GAME_UNDONE` with a reference to the exact game/event being undone.

Prefer deriving winner-stays transitions from validated goal/expiry/draw events on the server. Do not accept a client command that directly supplies arbitrary active teams or queue contents.

## Timer trust boundary

Online timer handling can use server timestamps. Offline operation cannot be strongly server-authoritative because no trusted server clock is available while disconnected.

- Client monotonic elapsed time is useful while the page remains alive, but it does not survive every browser/device restart.
- Client wall-clock timestamps can be changed and are not proof of when an event occurred.
- The server must not treat `clientCreatedAt` or an offline expiry timestamp as trusted truth.
- Preserve the last accepted server timer anchors and remaining duration. Reconnect must not restart or extend the clock.
- During implementation, define one explicit offline-expiry policy. If evidence cannot establish a defensible expiry, leave the game pending and require organiser resolution rather than inventing a precise outcome.
- Mark accepted offline timer outcomes as having been resolved under the offline policy; do not claim they have the same tamper resistance as continuously connected server timing.

## Single-controller constraint

The first offline release is single-controller per match session. Existing organiser/result bearer-token access is not a multi-device identity or concurrency system.

- Enforce one active controller lease/session if the current product can support it safely; otherwise document and enforce the simpler single-device operating rule at the product layer for the first release.
- Version checks and row locks remain mandatory even with the single-device constraint.
- Do not attempt last-write-wins merging of scores, queue state, timer state, or undo.
- Multi-device concurrent offline operation is out of scope.

## Storage strategy and migration gate

Do not assume that the existing `rotation_state` JSONB alone is sufficient for robust idempotency. A durable operation receipt/index may be required to guarantee uniqueness across retries and transactions.

Before implementation:
1. Inspect current schema, migrations, route/controller/service/validator structure, and database transaction helpers.
2. Choose the smallest durable design that supports unique operation IDs and atomic state updates.
3. Prefer additive schema changes only when justified; do not rewrite or drop existing data.
4. Prepare and test a numbered migration on a disposable Neon branch.
5. Obtain explicit approval before applying any new migration to production.
6. Keep startup free of DDL and keep the existing Neon production database as the system of record.

Potential implementation choices include a dedicated `match_operation_receipts` table with a unique `operation_id`, match/session reference, canonical payload hash, resulting version, and acknowledgement metadata; or a carefully indexed event log. The final choice must be based on current schema and expected event volume, not assumed in advance.

## Security requirements

- Continue to use the established bearer-token authorisation path; never trust actor identity in the operation body.
- Never store raw bearer tokens in operation receipts or event payloads.
- Ensure public community reads cannot access privileged operation receipts or mutate match state.
- Validate that scorer and assister belong to the scoring team and reject self-assists, consistent with current rules.
- Apply request size and batch-size limits.
- Avoid leaking token material in logs, error responses, or idempotency diagnostics.
- Revoked organiser/admin tokens must fail on the next server request; cached offline permissions are provisional.

## Rollout phases

1. Audit current API transaction boundaries, rotation JSONB shape, token validation, and deployed revision.
2. Specify operation envelope, stable error codes, version semantics, and timer offline policy.
3. Implement idempotency receipt persistence and atomic versioned event application.
4. Add bounded sync endpoint and acknowledgement/conflict responses.
5. Add tests for duplicate delivery, payload collision, stale version, invalid sequence, concurrent requests, rollback, revoked tokens, and timer boundaries.
6. Validate migration on a disposable Neon branch; request production migration approval separately.
7. Deploy backend before enabling frontend offline writes; verify Render is running the intended commit.
8. Enable frontend sync behind a controlled rollout and monitor conflict/rejection rates.

## Backend acceptance criteria

- Retrying a committed operation ID never changes state a second time.
- Reusing an ID with a different payload is rejected.
- State mutation and operation acknowledgement are atomic.
- Two concurrent requests cannot corrupt rotation state.
- Stale versions never overwrite newer state.
- Invalid team/scorer/assister/outcome transitions are rejected.
- Conflicts return current state/version and do not discard client data.
- Revoked tokens cannot sync queued privileged operations.
- Timer policy explicitly handles offline expiry and does not claim impossible server certainty.
- Existing matches and tournament/community data remain intact.
- No automatic production DDL occurs at startup.

## Related documentation

- [Frontend offline product and IndexedDB plan](https://github.com/olexxee141-oss/matchset/blob/main/docs/offline-support.md)
- [Current API contract](docs/api-contract.md)
- [Migration 001 — admin and tournament grouping](docs/migrations/001_admin_tournament_grouping.sql)
- [Migration 002 — winner-stays rotation](docs/migrations/002_winner_stays_rotation.sql)
