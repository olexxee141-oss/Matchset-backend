import { describe, expect, it, vi } from 'vitest';
import { createRecoveryEmailProvider, createResendRecoveryEmailProvider } from '../server/email/recoveryEmailProvider.js';

describe('Resend recovery email provider', () => {
  it('sends a one-time verification link through the Resend API', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const provider = createResendRecoveryEmailProvider({
      apiKey: 're_test_key',
      from: 'MatchSet <auth@example.com>',
      fetchImpl,
    });

    await provider.sendRecoveryVerificationEmail({
      to: 'person@example.com',
      verificationUrl: 'https://matchset-teal.vercel.app/recover/verify?token=opaque',
      expiresInMinutes: 15,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer re_test_key');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      from: 'MatchSet <auth@example.com>',
      to: ['person@example.com'],
      subject: 'Your MatchSet account recovery link',
    });
    expect(body.text).toContain('https://matchset-teal.vercel.app/recover/verify?token=opaque');
  });

  it('fails closed when provider credentials are missing', async () => {
    const provider = createResendRecoveryEmailProvider({ apiKey: '', from: '' });
    await expect(provider.sendRecoveryVerificationEmail({
      to: 'person@example.com',
      verificationUrl: 'https://matchset-teal.vercel.app/recover/verify',
      expiresInMinutes: 15,
    })).rejects.toThrow('not configured');
  });

  it('rejects non-HTTPS verification links', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = createResendRecoveryEmailProvider({ apiKey: 're_test_key', from: 'auth@example.com', fetchImpl });
    await expect(provider.sendRecoveryVerificationEmail({
      to: 'person@example.com',
      verificationUrl: 'http://evil.example/recover',
      expiresInMinutes: 15,
    })).rejects.toThrow('must use HTTPS');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not expose Resend response bodies when delivery fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('private recipient metadata', { status: 500 }));
    const provider = createResendRecoveryEmailProvider({ apiKey: 're_test_key', from: 'auth@example.com', fetchImpl });
    await expect(provider.sendRecoveryVerificationEmail({
      to: 'person@example.com',
      verificationUrl: 'https://matchset-teal.vercel.app/recover/verify',
      expiresInMinutes: 15,
    })).rejects.toThrow('Recovery email delivery failed.');
  });
});
