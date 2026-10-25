import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function secret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function matchesSecret(value: string, hash: string): boolean {
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(hashSecret(value), 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
