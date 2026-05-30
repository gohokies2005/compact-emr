/**
 * Warn-only sanity checks + locked-range computation for the cloud letter editor.
 *
 * Ported from the local FRN `app/services/letterEditService.js` (sanityCheckEdit +
 * _cleanProseForEdit + _computeLockedRanges). The editor NEVER hard-blocks a save — the
 * physician is the final authority and sign-off never dead-ends
 * (feedback_signoff_always_override). These surface as warnings the UI shows alongside the
 * saved version. The diff-SIZE rules from the local surgical-edit path are intentionally NOT
 * ported: a full-document editor save legitimately changes many lines.
 */

export interface SanityFinding {
  readonly rule: string;
  readonly detail: string;
}

export interface LockedRange {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

const LOCKED_FRAGMENTS: readonly { readonly frag: string; readonly label: string }[] = [
  { frag: 'I, Ryan J. Kasky, DO, am board-certified', label: 'Section I — physician credentials' },
  { frag: 'Nieves-Rodriguez v. Peake', label: 'Section II — Nieves-Rodriguez methodology' },
  { frag: 'I have no treatment relationship with this veteran', label: 'Section I — no treatment relationship' },
];

const JARGON_WORDS: readonly string[] = [
  'sidecar', 'drainer', 'outbox', 'endpoint', 'payload', 'linter', 'JSON', 'API', 'REST', 'HTTP', 'HTTPS',
];

const BANNED_WORDS: readonly string[] = [
  'compelling', 'overwhelming', 'clearly demonstrates', 'without a doubt', 'cannot be overstated', 'importantly', 'notably',
];

const PLACEHOLDER_RE = /\[\s*(?:VERIFY|TODO|PLACEHOLDER|FIXME|NEEDS|INSERT|FILL[ _]IN|CITATION NEEDED|TBD|XXX|FIX_ME)\b[^\]]*\]/gi;

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m === null ? 0 : m.length;
}

/**
 * Deterministic FRN-style cleanup applied to every save: em/en dashes, smart quotes, and
 * ellipses have one correct substitution under FRN letter style, so auto-clean rather than
 * bounce the edit. Leaves `**bold**` markdown alone.
 */
export function cleanProseForSave(text: string): string {
  return text
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*–\s*/g, '-')
    .replace(/[―−]/g, ',')
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/…/g, '...')
    .replace(/[  ]/g, ' ');
}

/**
 * Warn-only findings comparing the prior version (oldText) to the saved text (newText). An
 * empty array means clean. Never throws; never blocks.
 */
export function sanityCheckLetterText(oldText: string, newText: string): SanityFinding[] {
  const findings: SanityFinding[] = [];

  for (const { frag } of LOCKED_FRAGMENTS) {
    if (oldText.includes(frag) && !newText.includes(frag)) {
      findings.push({ rule: 'locked_block_corrupted', detail: `locked fragment removed: "${frag.slice(0, 60)}"` });
    }
  }

  if (countMatches(newText, /—/g) > countMatches(oldText, /—/g)) {
    findings.push({ rule: 'em_dash_introduced', detail: 'new em dashes (banned per FRN letter style)' });
  }

  for (const word of JARGON_WORDS) {
    const isAcronym = word === word.toUpperCase();
    const re = new RegExp(`\\b${word}\\b`, isAcronym ? 'g' : 'gi');
    if (countMatches(newText, re) > countMatches(oldText, re)) {
      findings.push({ rule: 'engineering_jargon_introduced', detail: `"${word}" introduced (per feedback_engineering_jargon_leakage)` });
    }
  }

  for (const bad of BANNED_WORDS) {
    const re = new RegExp(`\\b${bad}\\b`, 'gi');
    if (countMatches(newText, re) > countMatches(oldText, re)) {
      findings.push({ rule: 'banned_word_introduced', detail: `"${bad}" introduced (CLAUDE.md TONE list)` });
    }
  }

  if (countMatches(newText, PLACEHOLDER_RE) > countMatches(oldText, PLACEHOLDER_RE)) {
    findings.push({ rule: 'placeholder_token_introduced', detail: 'bracketed scaffolding token (e.g. [VERIFY ...]) — never ship in a finished letter' });
  }

  return findings;
}

/**
 * Char-offset spans of locked content the editor greys out + protects. v1: the exact locked
 * sentences wherever they appear (cheap + lossless). Returned by GET /cases/:id/letter.
 */
export function computeLockedRanges(text: string): LockedRange[] {
  const ranges: LockedRange[] = [];
  for (const { frag, label } of LOCKED_FRAGMENTS) {
    const idx = text.indexOf(frag);
    if (idx >= 0) ranges.push({ start: idx, end: idx + frag.length, label });
  }
  return ranges.sort((a, b) => a.start - b.start);
}
