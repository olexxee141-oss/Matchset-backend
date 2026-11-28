# MatchSet backend

## Authentication

Passkey authentication uses discoverable WebAuthn credentials. Account creation does not require an email address. Recovery requires the one-time recovery code and an email address supplied at recovery time. The recipient address is passed directly to the email provider and is not persisted by MatchSet.

Configure `WEBAUTHN_RP_NAME`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `APP_BASE_URL`, `AUTH_EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and `AUTH_EMAIL_FROM`. Production must use HTTPS and the exact frontend origin. Do not use preview deployment origins as production RP origins.

## Database migrations

Apply migrations in order on a disposable Neon branch first:
1. `docs/migrations/001_admin_tournament_grouping.sql`
2. `docs/migrations/002_winner_stays_rotation.sql`
3. `docs/migrations/003_shared_identity.sql`
4. `docs/migrations/004_auth_flow_security.sql`

No migration is run automatically by the application. Production application requires backup, explicit review, and rollback plan. See [identity rollout and rollback plan](docs/migrations/identity-rollout.md).

## Local development

```bash
npm install
npm run dev
```

## Verification

```bash
npm run typecheck
npm test
npm run build
```
