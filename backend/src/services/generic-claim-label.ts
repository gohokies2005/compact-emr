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

// ── Tier A deterministic JUNK guard (Greene `--EYES--` incident, 2026-07-14) ──────────────────────────────
// A Jotform dropdown SEPARATOR row ("--EYES--", "----") reached Case.claimedCondition verbatim. DISTINCT
// from isGenericClaimLabel above: a GENERIC label is a real-but-vague claim worth AI-narrowing; JUNK is not a
// claim at all and is refused at write time (persisted empty) and at prefill time (never offered).
// Conservative: only unambiguous non-labels — separator tokens, empty/whitespace, punctuation-only. Real
// conditions with internal hyphens/punctuation ("L5-S1 radiculopathy", "Tinnitus (bilateral)") never match.

// Separator token: a LEADING and TRAILING run of 2+ dashes ("--EYES--", "----", "-- Knees --").
const SEPARATOR_TOKEN = /^-{2,}[\s\S]*-{2,}$/;
// Punctuation-only: contains no letter or digit in any script.
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * True when `label` must NEVER be persisted or offered as a claimed condition: a dropdown separator
 * token, empty/whitespace, punctuation-only, or a non-string. False for every real condition label
 * (including ones this module would call generic — those go to the AI-narrow path instead).
 */
export function isInvalidClaimLabel(label: string | null | undefined): boolean {
  if (typeof label !== 'string') return true;
  const v = label.trim();
  if (v.length === 0) return true;
  if (SEPARATOR_TOKEN.test(v)) return true;
  if (!HAS_WORD_CHAR.test(v)) return true;
  return false;
}
