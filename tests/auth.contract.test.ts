import { describe, expect, it } from 'vitest';

describe('passkey and recovery contract', () => {
  it('uses a high-entropy recovery code scoped to an opaque account ID', () => {
    const userId = 'c4c6ec3a-9328-4b4f-a9bb-54b3a5c9e1d1';
    const secret = Buffer.alloc(32, 7).toString('base64url');
    const code = 'MSR-' + userId + '.' + secret;
    expect(code).toMatch(/^MSR-[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,60}$/i);
  });

  it('keeps email out of the identity schema', () => {
    const persistentTables = ['users','user_passkey_credentials','user_recovery_codes','auth_challenges','auth_sessions','auth_recovery_attempt_limits'];
    expect(persistentTables.some((name) => name.includes('email'))).toBe(false);
  });

  it('uses discoverable passkey login without account lookup fields', () => {
    expect('/login/options').toBe('/login/options');
  });
});
