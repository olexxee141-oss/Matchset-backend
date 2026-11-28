# Shared identity and authentication foundation

Status: approved product direction; implementation not yet enabled.

## Decision

Introduce global MatchSet users and community-scoped memberships. Authentication proves control of an account; membership proves participation in a particular community; roles grant authority only inside that community.

## Target data model

- `users`: opaque UUID primary key, account status, created/updated timestamps.
- `user_login_identities`: user ID, normalized email, verified timestamp, unique normalized email. Email is private and is not a public identifier.
- `auth_challenges`: hashed one-time verification code/token, expiry, attempt count, consumed timestamp, purpose, and delivery metadata. Store no plaintext code.
- `auth_sessions`: hashed opaque session token, user ID, expiry, rotation/revocation timestamps, device metadata. Never store or return raw session tokens from persistence.
- `community_memberships`: opaque membership ID, community ID, nullable user ID while unclaimed, display name, membership status, community-scoped role, timestamps. Unique (community_id, user_id) when user_id is not null. Do not make display_name unique.
- `membership_claim_invitations`: exact legacy membership ID, hashed single-use token, issuer membership/user, expiry, consumed timestamp, claimant user, audit metadata.
- `community_audit_events`: actor user/membership, action, target, community, timestamp, safe metadata.

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

## Authentication protocol

Use passwordless email verification. Generate cryptographically secure, short-lived, single-use challenges; persist only a hash; enforce attempt and resend limits; consume challenges atomically; prevent replay. Avoid logging challenge codes or session credentials.

Issue opaque, high-entropy sessions. Store only hashes server-side; rotate on authentication and privilege-sensitive transitions; support logout and global session revocation. Prefer secure HttpOnly SameSite cookies. If cookie auth is used, add CSRF protection and strict origin checks. CORS alone is not authorization.

The transactional email provider is a deployment prerequisite. Keep provider integration behind an adapter and fail closed if delivery cannot be completed. Do not add fake OTPs, development bypasses, or hardcoded credentials to production paths.

## Authorization transition

1. Add authentication tables and services additively.
2. Add session middleware without changing existing route semantics.
3. Add account claim for the current community owner, requiring the existing owner credential plus verified account.
4. Add explicit, single-use roster claim invitations issued by the community owner (or a narrowly scoped authorized delegate if product policy later allows).
5. Convert admin roles to membership-scoped permissions. Admin in community A must not authorize community B.
6. Convert every match/goal/assist/player-stat reference to stable membership IDs. Preserve old history through an explicit legacy identity mapping; do not rewrite by names.
7. Maintain compatibility with legacy owner/admin tokens until each community has a verified owner and recovery path. Record migration coverage before removing them.

## Required audit before implementation

Inspect actual production schema and migration history; all route/controller/service authorization checks; organiser/admin/result token creation, hashing, transport and browser storage; match and rotation JSON structures; scorer/assister/member references; tournament membership; CORS and cookie topology; and existing tests.

## Migration safety

- Additive migrations only in early phases.
- Validate against a disposable Neon branch or database clone.
- No automatic DDL at application startup.
- No production migration without explicit review and backup/rollback plan.
- Preserve all existing community, roster, match, tournament, rotation, goal and audit data.
- CI must cover duplicate names, cross-community membership, cross-community role isolation, unclaimed membership, claim replay/expiry, session revocation, and legacy-token compatibility.

## Open implementation gates

- Select and configure transactional email provider and sender domain.
- Confirm frontend and API hostnames so cookie domain/SameSite/Secure settings are correct.
- Confirm current schema/table names and legacy token semantics before migration.
- Define owner recovery when the original owner loses the legacy credential. Do not let a public invite link become an ownership recovery mechanism.
