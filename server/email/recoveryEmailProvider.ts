export type RecoveryVerificationEmail = {
  to: string;
  verificationUrl: string;
  expiresInMinutes: number;
};

export interface RecoveryEmailProvider {
  sendRecoveryVerificationEmail(message: RecoveryVerificationEmail): Promise<void>;
}

type ResendOptions = {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createResendRecoveryEmailProvider(options: ResendOptions): RecoveryEmailProvider {
  const apiKey = options.apiKey.trim();
  const from = options.from.trim();
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async sendRecoveryVerificationEmail(message) {
      if (!apiKey || !from) throw new Error('Recovery email delivery is not configured.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to)) {
        throw new Error('Recovery email destination is invalid.');
      }

      let verificationUrl: URL;
      try {
        verificationUrl = new URL(message.verificationUrl);
      } catch {
        throw new Error('Recovery verification URL is invalid.');
      }
      if (verificationUrl.protocol !== 'https:' && verificationUrl.hostname !== 'localhost') {
        throw new Error('Recovery verification URL must use HTTPS.');
      }
      if (!Number.isInteger(message.expiresInMinutes) || message.expiresInMinutes < 1 || message.expiresInMinutes > 60) {
        throw new Error('Recovery link expiry must be between 1 and 60 minutes.');
      }

      const safeUrl = escapeHtml(verificationUrl.toString());
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: 'Your MatchSet account recovery link',
          text: [
            'A request was made to recover your MatchSet account.',
            '',
            `Verify this request within ${message.expiresInMinutes} minutes:`,
            verificationUrl.toString(),
            '',
            'If you did not request this, you can ignore this email.',
          ].join('\n'),
          html: [
            '<p>A request was made to recover your MatchSet account.</p>',
            `<p><a href="${safeUrl}">Verify your recovery request</a></p>`,
            `<p>This link expires in ${message.expiresInMinutes} minutes.</p>`,
            '<p>If you did not request this, you can ignore this email.</p>',
          ].join(''),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        // Do not include provider response bodies: they can contain recipient or message metadata.
        throw new Error('Recovery email delivery failed.');
      }
    },
  };
}

export function createRecoveryEmailProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): RecoveryEmailProvider {
  if (env.AUTH_EMAIL_PROVIDER !== 'resend') {
    throw new Error('AUTH_EMAIL_PROVIDER must be set to resend.');
  }
  return createResendRecoveryEmailProvider({
    apiKey: env.RESEND_API_KEY ?? '',
    from: env.AUTH_EMAIL_FROM ?? '',
    fetchImpl,
  });
}
