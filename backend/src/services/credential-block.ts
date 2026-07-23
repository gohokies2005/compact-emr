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
 * The Section I credential-FACTS sentence(s) ONLY — the leading clause of the qualifications
 * paragraph that carries the signer's name, board certification, license, and NPI, WITHOUT the
 * fixed "I have no treatment relationship … VA disability claim." tail. This is the exact span the
 * approve path rewrites when a non-Kasky physician signs a legacy hardcoded-Kasky letter (the tail
 * — including the drafter-chosen veteran pronoun — is signer-agnostic and is left untouched).
 *
 * BYTE-IDENTITY: for a fully-credentialed physician (board + license present) this reproduces the
 * historically-hardcoded Kasky prefix VERBATIM, so it is exactly `renderSection1Credentials(c, p)`
 * minus its tail — the credential-block round-trip test pins this against demo-letter.txt.
 *
 * DPT-AWARE (mirrors buildRendererCredentialLines): a Doctor of Physical Therapy carries no board
 * certification and letters render NPI-only, so the board clause and the license clause are each
 * emitted only when their fields are present. A name+NPI-only provider renders a valid, board-free
 * qualifications sentence rather than a malformed "board-certified in  through the  ()" fragment.
 */
export function renderSection1CredentialFacts(c: SignerCredentials): string {
  const hasBoard = c.specialty.trim() !== '' && c.boardName.trim() !== '' && c.boardAbbreviation.trim() !== '';
  const hasLicense = c.licenseState.trim() !== '' && c.licenseNumber.trim() !== '';
  if (hasBoard && hasLicense) {
    // Kasky path — BYTE-IDENTICAL to today's hardcoded Section I facts sentence.
    return (
      `I, ${c.fullNameWithCredential}, am board-certified in ${c.specialty} through the ` +
      `${c.boardName} (${c.boardAbbreviation}). I hold an active medical license in ` +
      `${c.licenseState} (License #${c.licenseNumber}) with NPI ${c.npi}.`
    );
  }
  if (hasBoard && !hasLicense) {
    return (
      `I, ${c.fullNameWithCredential}, am board-certified in ${c.specialty} through the ` +
      `${c.boardName} (${c.boardAbbreviation}). My National Provider Identifier (NPI) is ${c.npi}.`
    );
  }
  if (!hasBoard && hasLicense) {
    return (
      `I am ${c.fullNameWithCredential}. I hold an active medical license in ` +
      `${c.licenseState} (License #${c.licenseNumber}) with NPI ${c.npi}.`
    );
  }
  // DPT path: the post-nominal in the name carries the qualification; NPI is the universal identifier.
  return `I am ${c.fullNameWithCredential}. My National Provider Identifier (NPI) is ${c.npi}.`;
}

/**
 * Rewrite the LEGACY hardcoded-Kasky Section I credential sentence so it names the ASSIGNED signer.
 * The Fargate drafter bakes Dr. Kasky's Section I facts into the letter body and emits NO signer
 * sentinel; when a different physician (e.g. Kevin Luiz, DPT) is the assigned signer, the positive
 * name gate would 409 (`signer_name_absent`) because the body still reads "Ryan J. Kasky, DO …".
 * This replaces the known hardcoded facts prefix with the assigned signer's facts, and — when the
 * letter is co-signed — appends a one-sentence concurrence naming the co-signer.
 *
 * The replaced span is the pronoun-INDEPENDENT facts prefix (up through "… NPI 1073018958."); the
 * fixed treatment-relationship tail that follows it in the body (with the drafter's veteran pronoun)
 * is preserved verbatim.
 *
 * BYTE-IDENTICAL GUARANTEE (the c0 regression guard):
 *   - When the assigned signer IS Dr. Kasky (NPI identity), return the input unchanged AND never
 *     append a concurrence — the output is the input, character for character. Keyed on NPI, NOT a
 *     rendered-form comparison: the drafter bakes the NPI-only form while renderSection1CredentialFacts
 *     (KASKY) yields the license form, so a form-equality guard would REWRITE every real Kasky letter.
 *   - When no known hardcoded-Kasky Section I prefix is present (already-sentinel-substituted,
 *     hand-edited, or authored under a different name), nothing matches → the input passes through
 *     untouched and the downstream name gate still fires. This never manufactures a passing letter.
 * split().join() (not replaceAll) so a `$` in any credential can never be read as a replacement pattern.
 */
export function substituteHardcodedSection1Credentials(
  letterText: string,
  signerCreds: SignerCredentials,
  coSignerCredentialedName: string | null,
): string {
  // Kasky signs a Kasky letter → byte-identical no-op, keyed on NPI identity (see doc above).
  if (signerCreds.npi.trim() === KASKY_CREDENTIALS.npi.trim()) return letterText;
  const replacement = renderSection1CredentialFacts(signerCreds);
  const concurrence =
    coSignerCredentialedName !== null && coSignerCredentialedName.trim() !== ''
      ? ` This opinion has been independently reviewed and concurred in by ${coSignerCredentialedName}.`
      : '';
  // Anchor on the drafter's ACTUAL baked prefix first (the NPI form the Fargate drafter emits today),
  // then the legacy license form as a fallback for any older letter that still carries it. First anchor
  // present wins; none present → not a hardcoded-Kasky letter → untouched.
  const legacyLicenseForm = renderSection1CredentialFacts(KASKY_CREDENTIALS);
  for (const anchor of [DRAFTER_HARDCODED_SECTION1_FACTS, legacyLicenseForm]) {
    if (letterText.includes(anchor)) return letterText.split(anchor).join(replacement + concurrence);
  }
  return letterText;
}

/**
 * The Section I credential-facts prefix the Fargate drafter ACTUALLY bakes into every letter body
 * (app/services/claude.js `lockedSectionI`). NPI-only form adopted 2026-06-10 when the medical-license
 * line was removed from rendered letters. The prior anchor re-derived this from KASKY_CREDENTIALS (which
 * carries a Nevada license) → the LICENSE form, which matches only the stale demo-letter.txt fixture and
 * NEVER a real letter, so the substitution silently no-op'd on every live letter (Kevin Luiz DPT could
 * not sign, 2026-07-21). Kept as a verbatim literal so it tracks the drafter's real output. If the
 * drafter's Section I wording ever changes, THIS constant must change with it (there is a paired test).
 */
export const DRAFTER_HARDCODED_SECTION1_FACTS =
  'I, Ryan J. Kasky, DO, am board-certified in Family Medicine through the American Board of Osteopathic Family Physicians (ABOFP). My National Provider Identifier (NPI) is 1073018958.';

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

/**
 * SHARED signer/co-sign substitution (Ryan 2026-07-22 — definitive fix for the DPT-delivery 409). This is
 * THE transform that turns a canonical letter (hardcoded-Kasky Section I and/or signer sentinels) into the
 * FINAL provider-substituted bytes: first resolve any signer sentinels ('their' pronoun, matching the approve
 * lane), then rewrite the hardcoded Section I credentials to the assigned signer + append a co-signer
 * concurrence. BYTE-IDENTICAL no-op for a Kasky signer of a hardcoded-Kasky letter (the Section-I step is a
 * Kasky-NPI no-op and legacy letters carry no sentinels).
 *
 * BOTH lanes that fingerprint the letter now call this: the APPROVE lane (which renders + delivers this exact
 * finalText) and the SIGN-OFF byte-binding (which must hash the SAME final bytes). Before this, sign-off bound
 * the raw Kasky-form canonical while approve delivered the DPT-form → every non-Kasky/co-signed letter
 * false-tripped `signed_bytes_changed` at delivery and could only be cleared by Dr. Kasky re-signing (which
 * defeats spreading signatures across providers). Sharing the transform makes signed-hash == delivered-hash by
 * construction, while a real medical-body edit still changes the hash and still blocks (anti-fraud intact).
 */
export function applySignerSubstitution(
  letterText: string,
  signerCreds: SignerCredentials,
  coSignerCredentialedName: string | null,
): string {
  const sentinelText = substituteSignerSentinels(letterText, signerCreds, 'their');
  return substituteHardcodedSection1Credentials(sentinelText, signerCreds, coSignerCredentialedName);
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
