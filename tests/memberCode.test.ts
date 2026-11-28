import { describe, expect, it } from 'vitest';
import { createMemberCode } from '../src/shared/memberCode.js';

describe('createMemberCode', () => {
  it('creates a stable uppercase code from the member UUID', () => {
    expect(createMemberCode('123e4567-e89b-12d3-a456-426614174000')).toBe('123E4567');
    expect(createMemberCode('123e4567-e89b-12d3-a456-426614174000')).toBe('123E4567');
  });
});
