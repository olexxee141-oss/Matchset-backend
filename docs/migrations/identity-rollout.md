# Shared identity production rollout and rollback plan

## Current status

- Migrations 003 and 004 are committed but have **not** been applied to the production Neon branch.
- Both migrations were applied together on a disposable branch cloned from production data.
- The test branch retained the original production-shaped row counts: 2 communities, 4 community members, 0 matches, 0 users, 0 passkeys.
- A duplicate display-name insert succeeded on the test branch and was rolled back.
- The new auth challenge flow-token and recovery-code acknowledgement columns were verified.
- No production data or schema was changed during validation.

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
