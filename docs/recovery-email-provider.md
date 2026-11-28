# Recovery email provider

MatchSet uses a provider adapter for recovery verification emails. The initial provider is Resend; authentication services depend on the `RecoveryEmailProvider` interface rather than Resend directly.

## Configuration

1. Create a Resend account and verify a sending domain.
2. Create an API key with permission to send email.
3. Configure these variables on the backend hosting service (Render):
   - `AUTH_EMAIL_PROVIDER=resend`
   - `RESEND_API_KEY`: Resend API key; secret, server-side only.
   - `AUTH_EMAIL_FROM`: sender using the verified domain, for example `MatchSet <auth@yourdomain.example>`.
   - `APP_BASE_URL`: public frontend origin used to construct recovery links.
4. Keep the API key out of source control, frontend variables, client bundles, and logs.

Do not use a Resend test sender for production. The sender domain must be verified in Resend and its DNS records must be configured as instructed by Resend.

## Privacy and failure behavior

- The adapter sends one recipient and one short-lived verification URL to Resend.
- MatchSet must not write the recipient address or verification URL to PostgreSQL, application logs, analytics, or audit metadata.
- Provider response bodies are intentionally excluded from thrown errors because they may contain recipient or message metadata.
- The request has a 10-second timeout. Non-success responses and timeouts fail closed; authentication must not treat a failed delivery as a verified recovery request.
- The application stores only the recovery challenge hash, account reference, purpose, expiry, attempts, and consumption state.
- Resend may retain recipient/message metadata under its own operational and retention policies. Review Resend's current data processing and retention terms and disclose that provider-side processing before enabling account recovery in production.

## Implementation boundary

This change adds only the provider interface, Resend adapter, configuration contract, and tests. It does not create recovery endpoints, generate recovery tokens, or persist email addresses. The authentication flow must generate the token, persist only its hash, construct an HTTPS link using the configured frontend origin, and consume the challenge only after successful verification.
