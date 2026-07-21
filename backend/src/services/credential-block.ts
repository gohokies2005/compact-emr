/**
 * Per-signer credential blocks for the IMO letter (D2 — the text half of the fraud gate).
 *
 * Today the drafter bakes "Ryan J. Kasky, DO" into Section I + the signature block. With
 * multiple signing physicians that is a fraud risk: the named/credentialed physician must
 * always be the one who actually signed. The fix is sentinels — the drafter emits a stable
 * [[SIGNER_CREDENTIALS]] / [[SIGNER_BLOCK]] marker where the signer's credentials go, and
 * compact-EMR substitutes the ASSIGNED physician's rendered blocks (built here) before the
 * text reaches the render Lambda.
 *
 * These two builders are the single source of the canonical prose. The round-trip test
 * (credential-block.test.ts) pins them byte-for-byte against prisma/demo-letter.txt (the Kasky
 * reference letter), so any wording drift fails CI rather than silently shipping a malformed
 * credential line.
 *
 * Scope note: this module is pure (no Prisma, no I/O) so it is trivially unit-testable. The
 * render-time threading (parse the assigned physician's block, substitute the sentinels,
 * fail-closed if a sentinel survives) lands in the approve/render path in D2 commit 3.
 */

/**
 * The render-authoritative credential facts for one signing physician. Persisted on
 * Physician.credentialBlockJson (stored as JSON, not columns, because these fields exist only
 * to render letter prose; the model's own fullName/npi/specialty columns drive listing/search).
 */
export interface SignerCredentials {
  /** Name with post-nominal exactly as printed, e.g. "Ryan J. Kasky, DO". */
  readonly fullNameWithCredential: string;
  /** Board specialty, e.g. "Family Medicine". */
  readonly specialty: string;
  /** Certifying board spelled out, e.g. "American Board of Osteopathic Family Physicians". */
  readonly boardName: string;
  /** Board abbreviation, e.g. "ABOFP". */
  readonly boardAbbreviation: string;
  /** License state spelled out, e.g. "Nevada". */
  readonly licenseState: string;
  /** License number only (no state prefix), e.g. "DO2996". */
  readonly licenseNumber: string;
  /** 10-digit NPI, e.g. "1073018958". */
  readonly npi: string;
}

/** Sentinel the drafter emits where Section I credentials belong. */
export const SECTION1_CREDENTIALS_SENTINEL = '[[SIGNER_CREDENTIALS]]';
/** Sentinel the drafter emits where the closing signature block belongs. */
export const SIGNATURE_BLOCK_SENTINEL = '[[SIGNER_BLOCK]]';

// A credential block is COMPLETE (signable) when the two UNIVERSAL fields are present: a printable
// name-with-credential and an NPI. Every provider — MD, DO, or DPT — has both. The board-certification
// pair (specialty/boardName/boardAbbreviation) and the state-license pair (licenseState/licenseNumber)
// are OPTIONAL (DPT co-sign, 2026-07-20): a Doctor of Physical Therapy carries no board certification,
// and letters render NPI-only (the license line was removed 2026-06-10). buildRendererCredentialLines
// already OMITS the board line when specialty/boardAbbreviation are blank, so a name+NPI block renders a
// valid DPT credential. Requiring the board/license fields here blocked DPT letter SIGNING even though
// the profile-save path + the renderer both support DPT — the exact bug Kevin Luiz, DPT hit.
const REQUIRED_CREDENTIAL_FIELDS: readonly (keyof SignerCredentials)[] = ['fullNameWithCredential', 'npi'];

/**
 * Section I qualifications sentence. The veteran's possessive pronoun ("his"/"her"/"their") is
 * veteran-specific, not signer-specific, so the caller supplies it.
 */
export function renderSection1Credentials(c: SignerCredentials, veteranPossessivePronoun: string): string {
  return (
    `I, ${c.fullNameWithCredential}, am board-certified in ${c.specialty} through the ` +
    `${c.boardName} (${c.boardAbbreviation}). I hold an active medical license in ` +
    `${c.licenseState} (License #${c.licenseNumber}) with NPI ${c.npi}. I have no treatment ` +
    `relationship with this veteran. This letter is an independent medical opinion prepared ` +
    `for the purpose of ${veteranPossessivePronoun} VA disability claim.`
  );
}

/** Closing signature block (4 lines, newline-joined, no trailing newline). */
export function renderSignatureBlock(c: SignerCredentials): string {
  return [
    c.fullNameWithCredential,
    `Board-Certified in ${c.specialty}, ${c.boardAbbreviation}`,
    `${c.licenseState} Medical License #${c.licenseNumber}`,
    `NPI: ${c.npi}`,
  ].join('\n');
}

/**
 * The credential lines the PDF/DOCX RENDERER stamps in the header + signature block, as a
 * newline-joined multi-line string (the renderer splits on \n). NPI-ONLY — the medical-license
 * line was removed from rendered letters 2026-06-10 (INCIDENTS), so this deliberately does NOT
 * include it (unlike renderSignatureBlock, which is the letter-BODY sentinel and is stripped
 * before render). For Dr. Kasky this reproduces the historically-hardcoded pdfgen/docxgen lines
 * EXACTLY: "Ryan J. Kasky, DO" / "Board-Certified in Family Medicine, ABOFP" / "NPI: 1073018958".
 * The board-cert line is omitted for a provider without a board certification (e.g. a DPT), so a
 * DPT renders name + NPI. Used by routes/letter.ts to pass signer_name / cosigner_name to the
 * renderer (was single-line fullNameWithCredential → the board-cert + NPI lines silently vanished
 * from every approved letter; regression caught by QA 2026-07-19).
 */
export function buildRendererCredentialLines(c: SignerCredentials): string {
  const lines = [c.fullNameWithCredential];
  if (c.specialty.trim() !== '' && c.boardAbbreviation.trim() !== '') {
    lines.push(`Board-Certified in ${c.specialty}, ${c.boardAbbreviation}`);
  }
  lines.push(`NPI: ${c.npi}`);
  return lines.join('\n');
}

/**
 * Replace the signer sentinels in a letter with the assigned physician's rendered blocks. A
 * no-op when no sentinel is present (the legacy hardcoded-credential letters that exist today
 * pass through byte-identical). Idempotent. split().join() rather than replaceAll so a `$` in a
 * credential string can never be read as a replacement pattern, and so every occurrence is
 * replaced deterministically. The veteran's possessive pronoun is veteran-specific (see
 * renderSection1Credentials) so the caller supplies it.
 */
export function substituteSignerSentinels(
  letterText: string,
  c: SignerCredentials,
  veteranPossessivePronoun: string,
): string {
  let out = letterText;
  if (out.includes(SECTION1_CREDENTIALS_SENTINEL)) {
    out = out.split(SECTION1_CREDENTIALS_SENTINEL).join(renderSection1Credentials(c, veteranPossessivePronoun));
  }
  if (out.includes(SIGNATURE_BLOCK_SENTINEL)) {
    out = out.split(SIGNATURE_BLOCK_SENTINEL).join(renderSignatureBlock(c));
  }
  return out;
}

const WORD_CHAR = /[A-Za-z]/;

/**
 * True if `name` appears in `haystack` bounded by a non-letter on each side (or a string edge).
 * Whole-name rather than bare substring so "Doe, MD" can't match inside "Doelan, MD", and the
 * credentialed name (which ends in a post-nominal like ", DO"/", MD") only counts when it's not
 * glued to surrounding letters. Checks every occurrence; returns true on the first bounded one.
 */
function nameAppearsAsWhole(haystack: string, name: string): boolean {
  if (name.length === 0) return false;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(name, from);
    if (i < 0) return false;
    const before = i === 0 ? '' : haystack[i - 1];
    const after = haystack[i + name.length] ?? '';
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = i + 1;
  }
}

/** Blank out whole-name occurrences of `name` so a shorter roster name that is a substring of it
 *  (e.g. "Jane Doe, MD" inside "Mary Jane Doe, MD") is not later mis-detected as foreign. */
function maskWholeName(text: string, name: string): string {
  if (name.length === 0) return text;
  let out = '';
  let from = 0;
  for (;;) {
    const i = text.indexOf(name, from);
    if (i < 0) return out + text.slice(from);
    const before = i === 0 ? '' : text[i - 1];
    const after = text[i + name.length] ?? '';
    const bounded = !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
    out += text.slice(from, i) + (bounded ? ' ' : name);
    from = i + name.length;
  }
}

/**
 * The positive identity check: does the letter name the assigned signer (whole-name match)?
 * The approve gate blocks when this is false ("the letter is not authored under the assigned
 * physician"). Exported so the gate and its tests share one definition.
 */
export function signerNameAppears(letterText: string, signerName: string): boolean {
  return nameAppearsAsWhole(letterText, signerName);
}

/**
 * The anti-fraud assertion: which OTHER known physicians' credentialed names appear in this
 * letter. The approve gate blocks if this returns anything non-empty — it means the letter body
 * names a physician who is not the assigned signer (e.g. physician #2 assigned to a letter whose
 * body still says "Ryan J. Kasky, DO"). Whole-name match, and the assigned signer's own name is
 * masked out first so a roster name that is a substring of the signer's name does not produce an
 * operator-unfixable false block. No fuzzy matching. The caller passes the active-physician
 * roster's credentialed names and the assigned signer's own name to exclude.
 */
export function findForeignSignerNames(
  letterText: string,
  rosterCredentialNames: readonly string[],
  selfName: string,
): string[] {
  const masked = maskWholeName(letterText, selfName);
  const found: string[] = [];
  for (const name of rosterCredentialNames) {
    if (name === selfName || name.trim().length === 0) continue;
    if (nameAppearsAsWhole(masked, name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Validate + narrow an untrusted JSON value (Physician.credentialBlockJson out of the DB) to
 * SignerCredentials. Returns null if any field is missing or non-string-or-blank — the render
 * path treats null as "this physician cannot sign yet" and fails closed (D2 commit 3), so a
 * half-filled profile can never produce a malformed credential line.
 */
export function parseCredentialBlock(value: unknown): SignerCredentials | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  for (const field of REQUIRED_CREDENTIAL_FIELDS) {
    const fieldValue = v[field];
    if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) return null;
  }
  const opt = (k: keyof SignerCredentials): string => (typeof v[k] === 'string' ? (v[k] as string) : '');
  return {
    fullNameWithCredential: v.fullNameWithCredential as string,
    specialty: opt('specialty'),
    boardName: opt('boardName'),
    boardAbbreviation: opt('boardAbbreviation'),
    licenseState: opt('licenseState'),
    licenseNumber: opt('licenseNumber'),
    npi: v.npi as string,
  };
}

/**
 * Compose a SignerCredentials from the admin-entered credential facts + the physician's existing
 * name/specialty/NPI. Used by the physician create/patch routes so the credential block is built
 * server-side on every write and can never drift from the model columns (the divergence risk of
 * storing the same value twice). Returns null if any field is blank (an incomplete profile that
 * the fraud gate will then block at approve until completed).
 */
export interface CredentialBlockInput {
  readonly fullNameWithCredential: string;
  readonly specialty: string;
  readonly npi: string;
  readonly boardName: string;
  readonly boardAbbreviation: string;
  readonly licenseState: string;
  readonly licenseNumber: string;
}
export function composeCredentialBlock(input: CredentialBlockInput): SignerCredentials | null {
  return parseCredentialBlock({
    fullNameWithCredential: input.fullNameWithCredential,
    specialty: input.specialty,
    boardName: input.boardName,
    boardAbbreviation: input.boardAbbreviation,
    licenseState: input.licenseState,
    licenseNumber: input.licenseNumber,
    npi: input.npi,
  });
}

/**
 * Kasky's canonical credentials — the reference signer the demo letter was built around. Used
 * by the round-trip test (the spec lock) and by the migration backfill (writes this onto the
 * Kasky Physician row keyed by NPI). Keep this in sync with prisma/demo-letter.txt; the
 * round-trip test enforces it.
 */
export const KASKY_CREDENTIALS: SignerCredentials = {
  fullNameWithCredential: 'Ryan J. Kasky, DO',
  specialty: 'Family Medicine',
  boardName: 'American Board of Osteopathic Family Physicians',
  boardAbbreviation: 'ABOFP',
  licenseState: 'Nevada',
  licenseNumber: 'DO2996',
  npi: '1073018958',
};
