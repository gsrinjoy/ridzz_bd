const encoder = new TextEncoder();

const toBase64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function key(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(secret: string, message: string): Promise<string> {
  return toBase64Url(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(message)));
}

/** Compares without exiting early, so timing cannot reveal how much of a guess was right. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const signRider = (secret: string, code: string, riderId: string) => sign(secret, `${code}:${riderId}`);

export async function verifyRider(secret: string, code: string, riderId: string, token: string): Promise<boolean> {
  return safeEqual(await signRider(secret, code, riderId), token);
}

// No 0/O/1/I/L: codes get read aloud at fuel stops.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newRideCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export const isRideCode = (code: string) => /^[A-HJKMNP-Z2-9]{6}$/.test(code);
