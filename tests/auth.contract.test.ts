import { describe, expect, it } from 'vitest';
import { equalHex, parseCode, recoveryHash } from '../server/auth/authRouter.js';

describe('passkey recovery security primitives', () => {
  const userId = 'c4c6ec3a-9328-4b4f-a9bb-54b3a5c9e1d1';
  const secret = Buffer.alloc(32, 7).toString('base64url');

  it('parses an account-scoped high-entropy recovery code', () => {
    expect(parseCode('MSR-' + userId + '.' + secret)).toEqual({ userId, secret });
  });

  it('rejects malformed recovery code account identifiers', () => {
    expect(parseCode('MSR-not-a-uuid.' + secret)).toBeNull();
    expect(parseCode('MSR-' + userId + '.short')).toBeNull();
  });

  it('derives a salted, non-plaintext recovery verifier', () => {
    const salt = 'c8a5e15e29ef8c14f731c61a6b6c02a1';
    const verifier = recoveryHash(secret, salt);
    expect(verifier).toHaveLength(128);
    expect(verifier).not.toContain(secret);
    expect(recoveryHash(secret, salt)).toBe(verifier);
    expect(recoveryHash(secret + 'x', salt)).not.toBe(verifier);
    expect(recoveryHash(secret, 'different-salt')).not.toBe(verifier);
  });

  it('compares full-length recovery verifiers safely and rejects malformed input', () => {
    const a = 'ab'.repeat(64);
    expect(equalHex(a, a)).toBe(true);
    expect(equalHex(a, 'cd'.repeat(64))).toBe(false);
    expect(equalHex('not-hex', a)).toBe(false);
    expect(equalHex('ab', 'abcd')).toBe(false);
  });
});
