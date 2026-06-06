import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// Password-protected delivery portal helpers (Ryan 2026-06-06). The URL token is the unguessable
// link secret; the password is a second factor emailed separately. The token + password together gate
// a presigned S3 URL to the signed letter PDF.

/** URL secret — 32 random bytes base64url (~43 chars), unguessable. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

// Human-friendly password from an UNAMBIGUOUS alphabet (no 0/O/1/l/I). 12 chars ≈ 71 bits of entropy,
// so brute force / rainbow tables are infeasible — a plain sha256 (unsalted) is sufficient here
// (this is a high-entropy machine-generated secret, not a low-entropy human password needing bcrypt).
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export function generatePassword(len = 12): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += PW_ALPHABET[bytes[i]! % PW_ALPHABET.length];
  return out;
}

export function hashPassword(pw: string): string {
  return createHash('sha256').update(pw, 'utf8').digest('hex');
}

/** Constant-time password check against the stored sha256 hex. */
export function verifyPassword(pw: string, storedHashHex: string): boolean {
  const a = createHash('sha256').update(pw, 'utf8').digest();
  let b: Buffer;
  try { b = Buffer.from(storedHashHex, 'hex'); } catch { return false; }
  return a.length === b.length && timingSafeEqual(a, b);
}
