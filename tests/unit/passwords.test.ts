import { describe, expect, it } from 'vitest';
import { digest, hashSecret, newRecoveryCode, newSessionToken, normaliseCode, passwordProblem, validEmail, verifySecret } from '../../src/server/modules/auth/passwords';

describe('passwords', () => {
  it('accepts the right password and refuses a wrong one', async () => {
    const stored = await hashSecret('correct horse');
    expect(await verifySecret('correct horse', stored)).toBe(true);
    expect(await verifySecret('correct hors', stored)).toBe(false);
  });
  it('never stores the password itself', async () => {
    expect(await hashSecret('correct horse')).not.toContain('correct horse');
  });
  it('salts: the same password hashes differently each time', async () => {
    expect(await hashSecret('same')).not.toBe(await hashSecret('same'));
  });
  it('records its cost so it can be raised later', async () => {
    expect((await hashSecret('x')).split('$')[1]).toBe('100000');
  });
  it('fails closed on a damaged record', async () => {
    expect(await verifySecret('x', 'not-a-hash')).toBe(false);
  });
  it('sets a minimum length', () => {
    expect(passwordProblem('short')).toBeTruthy();
    expect(passwordProblem('long enough')).toBeNull();
    expect(passwordProblem(undefined)).toBeTruthy();
    expect(passwordProblem('x'.repeat(200))).toBeTruthy();
  });
});

describe('tokens and codes', () => {
  it('makes unguessable, unique session tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, newSessionToken));
    expect(tokens.size).toBe(200);
    expect(newSessionToken().length).toBeGreaterThanOrEqual(43);
  });
  it('stores only a digest of a session', async () => {
    const t = newSessionToken();
    expect(await digest(t)).not.toContain(t);
    expect(await digest(t)).toBe(await digest(t));
  });
  it('makes recovery codes that are easy to copy down', () => {
    expect(newRecoveryCode()).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
  });
  it('accepts a recovery code typed loosely', () => {
    expect(normaliseCode('abcd efgh jkmn pqrs')).toBe('ABCD-EFGH-JKMN-PQRS');
  });
  it('validates email addresses', () => {
    expect(validEmail('rider@example.com')).toBe(true);
    expect(validEmail('rider@example')).toBe(false);
    expect(validEmail('no at sign.com')).toBe(false);
  });
});
