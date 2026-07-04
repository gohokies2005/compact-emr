/**
 * isGenericClaimLabel — the SINGLE EMR-side signal for "this claimed condition is a generic Jotform dropdown
 * CATCH-ALL that needs narrowing to a specific documented dx" (Ryan 2026-07-04, Drummond CLM-BE673DFF78:
 * claimedCondition was "Other Joint (shoulder, Hip, Ankle, Elbow, Wrist)"). The AI-narrow trigger (and any
 * future EMR pre-draft caution) read THIS so the definition lives in one place.
 *
 * CONSERVATIVE by design: a false positive would narrow a legitimately-specific claim, mis-driving the draft.
 * So it flags ONLY the unambiguous dropdown catch-alls — an "Other …" bucket, or a parenthetical LIST of
 * choices ("(shoulder, Hip, Ankle, …)"). It does NOT flag a real, specific diagnosis — including an ICD
 * "unspecified" (e.g. "Asthma, unspecified", "Major depressive disorder, unspecified") which is a legitimate
 * documented dx, not a dropdown catch-all.
 */

// A parenthetical containing a comma is the Jotform multi-option list shape: "Other Joint (shoulder, Hip, …)".
const MULTI_OPTION_PARENTHETICAL = /\([^)]*,[^)]*\)/;
// Bare body-region / catch-all buckets the intake dropdown emits with no specific condition attached.
const BARE_BUCKET = /^(other joint|other condition|other|musculoskeletal condition|joint condition|multiple (joints|conditions))\b/i;

export function isGenericClaimLabel(label: string | null | undefined): boolean {
  if (typeof label !== 'string') return false;
  const v = label.trim();
  if (v.length === 0) return false;
  // An "Other …" bucket, with or without a trailing parenthetical list, is always generic.
  if (/^other\b/i.test(v)) return true;
  if (BARE_BUCKET.test(v)) return true;
  // A parenthetical LIST of options ("X (shoulder, hip, ankle, elbow, wrist)") is a dropdown catch-all — but a
  // single parenthetical qualifier ("Tinnitus (bilateral)", "OSA (obstructive sleep apnea)") is NOT a list, so
  // require a comma inside the parentheses.
  if (MULTI_OPTION_PARENTHETICAL.test(v)) return true;
  return false;
}
