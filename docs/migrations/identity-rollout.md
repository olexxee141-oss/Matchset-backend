# Shared identity production rollout and rollback plan

## Current status

**Migrations 003 and 004 were applied successfully to production on 2026-11-28 after explicit user approval.**

- Production branch: `production` (`br-rough-mountain-bd3jmpma`).
- Pre-migration manual snapshot: `matchset-before-identity-migrations-003-004-2026-11-28` (`snap-lucky-butterfly-bdebuwgu`).
- Migration application used Neon's prepared-migration workflow: both migrations were tested on a temporary branch cloned from production, verified, then applied to the parent production branch.
- Temporary verification branch was deleted after application.
- Production post-migration counts: 2 communities, 4 community members, 0 matches, 0 tournaments, 0 users, 0 passkeys, 0 challenges, 0 sessions.
- Existing community and membership records/IDs remain unchanged; all legacy memberships remain unclaimed.
- The old community display-name uniqueness constraint is removed; the new active account-per-community uniqueness index is present.
- A duplicate display-name insert was tested and rolled back on the disposable branch.
- Production schema inspection confirmed the recovery-code acknowledgement and challenge flow-token columns.
- No user accounts or credentials were backfilled.

## Preconditions before production

1. Confirm the final production frontend origin and keep it stable. WebAuthn passkeys are bound to the RP ID; changing from `matchset-teal.vercel.app` to another domain later requires a planned credential migration strategy and may require users to register new passkeys.
2. Confirm Render's `FRONTEND_ORIGIN` is exactly `https://matchset-teal.vercel.app`.
3. Configure and verify the Resend sender domain, then add `AUTH_EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and `AUTH_EMAIL_FROM` to Render. Never put the API key in Vercel or source control.
4. Review Resend's provider-side retention and privacy terms.
5. Take a Neon backup/restore point and confirm the restore procedure before DDL.
6. Verify production row counts and current unique constraint names immediately before migration.
7. Apply migration 003 followed by migration 004 in a controlled maintenance window. Do not run migrations from application startup.

## Migration behavior

- Existing community and member IDs remain unchanged.
- Existing community memberships remain unclaimed; no name-based account matching occurs.
- Existing display names become non-unique. Stable membership IDs remain the references for matches and tournament participation.
- Auth tables start empty. No passkeys, sessions, recovery codes, or emails are backfilled.
- The email recipient address is transiently passed to Resend and is not stored by MatchSet.
- Existing owner/admin bearer-token behavior remains in place.

## Rollback strategy

Prefer an application rollback while retaining the additive schema. The old application does not require the new tables or columns, and retaining them avoids data loss.

Do **not** drop identity tables, remove `community_members.user_id`, or recreate the old display-name uniqueness constraint after any accounts or duplicate names have been created. Those actions could destroy identity claims or make valid membership rows impossible to restore.

If the new auth endpoints must be disabled, roll back the application release or disable the auth router while leaving the schema intact. Repair forward with a new migration after investigating the cause.

## Launch gates

- Backend CI green on the exact merged commit.
- Frontend CI green on the exact merged commit.
- Migrations 003 and 004 reviewed and applied to production only after explicit approval.
- Render deployment healthy after code release.
- Browser test on Android Chrome and at least one desktop browser: create account, save/acknowledge recovery code, sign out/in, add second passkey, recovery email link, new passkey, old session revocation, old passkey review/revocation.
- Confirm cookies are HttpOnly, Secure, SameSite=Lax and scoped to `/api`; confirm no email, raw recovery code, or raw verification token appears in app database or application logs.
