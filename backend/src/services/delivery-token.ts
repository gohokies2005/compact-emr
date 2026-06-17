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

// ── Identity-mode unlock (HIPAA audit APP-1 fix, Ryan 2026-06-11) ─────────────────────────────
// The unlock secret is data the veteran already knows — DOB + phone last-4 — so NOTHING secret
// ever rides the delivery email (link only). Factors chosen for zero ambiguity: digits only,
// never name-derived (multi-part surnames parse inconsistently across forms).

/** Stored Veteran.dob is @db.Date → a JS Date at UTC MIDNIGHT. Read the UTC calendar date —
 * NEVER getFullYear()/getMonth()/getDate(), which read local time and go off-by-one-day in any
 * negative-offset zone (architect plan-gate item A). */
export function dobToIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Accept only strict YYYY-MM-DD (the portal sends a date-picker value). No Date() parsing —
 * `new Date('3/15/80')` is locale quicksand. */
export function normalizeInputDob(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const v = s.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Last 4 digits of a STORED phone number. POLICY (Ryan 2026-06-17): take the last 4 of WHATEVER
 * number is on file — US, international (+49…), or oddly formatted — because the veteran enters the
 * last 4 of the number THEY gave us. The old "clean US only (10, or 11 with leading 1)" rule returned
 * null for any country-code/foreign number, which silently LOCKED OUT every veteran with a non-US
 * phone from their paid letter (Stanley Ewell, +49 13-digit number, could never unlock — identity
 * verification failed closed on the null stored last-4 no matter what he typed). Only a number with
 * fewer than 4 digits (genuinely unusable) returns null. (Tradeoff: a stored "…1234 ext 9" now yields
 * "2349" — but extensions are vanishingly rare in a phone field, and the international lockout is real
 * and recurring.) */
export function phoneLast4(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function ctEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Constant-time identity check: BOTH factors must match. Fails closed on any missing/garbled
 * stored value (null phone, <4 digits) — callers should not have minted an identity token then. */
export function verifyIdentity(
  input: { dob: unknown; phoneLast4: unknown },
  stored: { dob: Date; phone: string | null },
): boolean {
  const inDob = normalizeInputDob(input.dob);
  const inP4 = typeof input.phoneLast4 === 'string' && /^\d{4}$/.test(input.phoneLast4.trim())
    ? input.phoneLast4.trim()
    : null;
  const storedP4 = phoneLast4(stored.phone);
  if (inDob === null || inP4 === null || storedP4 === null) return false;
  // Evaluate both comparisons unconditionally (no short-circuit timing signal on which factor failed).
  const dobOk = ctEqual(inDob, dobToIso(stored.dob));
  const p4Ok = ctEqual(inP4, storedP4);
  return dobOk && p4Ok;
}
