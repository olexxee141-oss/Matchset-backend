# Shared identity and authentication foundation

Status: approved product direction; implementation not yet enabled.

## Decision

Introduce global MatchSet users and community-scoped memberships. Authentication proves control of an account; membership proves participation in a particular community; roles grant authority only inside that community.

Use WebAuthn passkeys for normal sign-in and a one-time recovery code for account recovery. MatchSet must not persist user email addresses. An email address entered during recovery is a temporary delivery destination only.

## Target data model

- `users`: opaque UUID primary key, account status, created/updated timestamps.
- `user_passkey_credentials`: user ID, WebAuthn credential ID (unique), public key, signature counter, transports, authenticator metadata, created/last-used/revoked timestamps. Never store private key material.
- `user_recovery_codes`: user ID, strong hash of one-time recovery code, created/consumed/revoked timestamps. Store no plaintext recovery code; replacement invalidates the previous code.
- `auth_challenges`: hashed one-time WebAuthn or recovery challenge, user ID where known, purpose, expiry, attempt count, consumed timestamp. Do not persist a recovery email address.
- `auth_sessions`: hashed opaque session token, user ID, expiry, rotation/revocation timestamps, safe device metadata. Never store or return raw session tokens from persistence.
- `community_memberships`: opaque membership ID, community ID, nullable user ID while unclaimed, display name, membership status, community-scoped role, timestamps. Unique (community_id, user_id) when user_id is not null. Do not make display_name unique.
- `membership_claim_invitations`: exact legacy membership ID, hashed single-use token, issuer membership/user, expiry, consumed timestamp, claimant user, audit metadata.
- `community_audit_events`: actor user/membership, action, target, community, timestamp, safe metadata. Do not put email addresses, recovery codes, passkey challenge data, or session secrets in metadata.

Names above are conceptual. Inspect the live schema and current table naming before writing migrations. Do not blindly create parallel tables if equivalent structures already exist.

## Invariants

- A person may have multiple community memberships.
- A user has at most one active membership in a given community.
- Different users may have identical display names, including within the same community.
- A user may have a different display name in every community.
- Community permissions are resolved from the membership in the requested community only.
- Goals, assists, match participants, and leaderboard aggregation must use stable membership IDs, never names.
- Unclaimed legacy roster rows remain distinct and cannot be auto-claimed by name matching.
- Public community links never grant write access.
- Legacy owner/admin tokens remain valid during a deliberate transition window; do not abruptly invalidate production users.

## Passkey authentication protocol

- Use WebAuthn with server-generated, cryptographically random, short-lived, single-use challenges.
- Verify challenge, origin, RP ID, credential ID, signature, user-presence/user-verification policy, and signature counter according to WebAuthn requirements.
- Store only credential public keys and required metadata. Private keys remain with the authenticator.
- Support multiple passkeys per account, passkey revocation, and session revocation.
- Do not add password or email-as-username authentication. Do not create a persistent email identity table.

## Recovery protocol (approved)

1. During account creation, generate a high-entropy recovery code and show it once. Require acknowledgement that the user has saved it.
2. Persist only a strong password-hash/KDF hash of the code, with a one-time consumed/revoked state. Never log or re-display it.
3. If the user loses access to all passkeys, they submit the recovery code and a current email address.
4. Validate the recovery code with constant-time comparison and strict attempt/rate limits. The code identifies the account; the email address does not.
5. Send a short-lived, single-use verification link to the supplied address. Do not persist the address in users, credentials, challenges, audit events, analytics, or logs. Store only the challenge hash, account reference, purpose, expiry, and consumption state. The email adapter receives the address only to deliver this one message.
6. After link verification, require registration of a new passkey, revoke existing sessions, allow review/revocation of previous passkeys, and issue a replacement recovery code. Consume the old recovery code atomically.
7. Email alone must never authenticate or recover an account. If both every passkey and the recovery code are lost, use a separately designed community-governance recovery process; do not invent an email lookup or silently bypass authentication.

Provider integration must be behind an adapter. The provider must not be configured to retain message content or recipient details beyond its documented operational needs; disclose provider-side retention before launch. The application itself must not retain the address. Fail closed if delivery cannot be completed, and do not consume the recovery code until recovery completes successfully (use a bounded, replay-safe recovery state machine).

## Session and authorization protocol

Issue opaque, high-entropy sessions. Store only hashes server-side; rotate after authentication and privilege-sensitive transitions; support logout and global session revocation. Prefer secure HttpOnly SameSite cookies. If cookie auth is used, add CSRF protection and strict origin checks. CORS alone is not authorization.

## Authorization transition

1. Add authentication tables and services additively.
2. Add session middleware without changing existing route semantics.
3. Add account claim for the current community owner, requiring the existing owner credential plus authenticated passkey account.
4. Add explicit, single-use roster claim invitations issued by the community owner (or a narrowly scoped authorized delegate if product policy later allows).
5. Convert admin roles to membership-scoped permissions. Admin in community A must not authorize community B.
6. Convert every match/goal/assist/player-stat reference to stable membership IDs. Preserve old history through an explicit legacy identity mapping; do not rewrite by names.
7. Maintain compatibility with legacy owner/admin tokens until each community has a verified owner and tested recovery path. Record migration coverage before removing them.

## Required audit before implementation

Inspect actual production schema and migration history; all route/controller/service authorization checks; organiser/admin/result token creation, hashing, transport and browser storage; match and rotation JSON structures; scorer/assister/member references; tournament membership; CORS and cookie topology; and existing tests.

## Migration safety

- Additive migrations only in early phases.
- Validate against a disposable Neon branch or database clone.
- No automatic DDL at application startup.
- No production migration without explicit review and backup/rollback plan.
- Preserve all existing community, roster, match, tournament, rotation, goal and audit data.
- CI must cover duplicate names, cross-community membership, cross-community role isolation, unclaimed membership, claim replay/expiry, passkey challenge validation, recovery-code replay/expiry, session revocation, and legacy-token compatibility.

## Open implementation gates

- Select and configure a transactional email provider for one-time recovery delivery; do not store its recipient address in the application database.
- Confirm frontend and API hostnames so cookie domain/SameSite/Secure settings and WebAuthn RP ID/origin are correct.
- Confirm current schema/table names and legacy token semantics before migration.
- Define owner/community-governance recovery for the rare case where all passkeys and the recovery code are lost. Do not let a public invite link become an ownership recovery mechanism.
