const encoder = new TextEncoder();
/** The most Workers' WebCrypto allows. */
const ITERATIONS = 100_000;

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const fromHex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));

async function derive(secret: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return hex(bits);
}

/** Stored as pbkdf2$iterations$salt$hash, so the cost can rise later without breaking old passwords. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${hex(salt)}$${await derive(secret, salt, ITERATIONS)}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [, iterations, salt, expected] = stored.split('$');
  if (!iterations || !salt || !expected) return false;
  const actual = await derive(secret, fromHex(salt), Number(iterations));
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Hashed with an unrelated secret so an unknown email takes as long as a wrong password. */
export const DUMMY_HASH_INPUT = 'timing-equaliser';

export const newSessionToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Only this digest is stored, so a leaked database holds no usable sessions. */
export async function digest(token: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Four groups of four: about 79 bits, and readable enough to write down. */
export function newRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export const normaliseCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');

export const validEmail = (email: string) => email.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Enter a password';
  if (password.length < 8) return 'Use at least 8 characters';
  if (password.length > 128) return 'That password is too long';
  return null;
}
