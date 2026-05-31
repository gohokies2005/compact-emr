/**
 * Deterministic structured-edit applier for the surgical-AI editor (cloud).
 *
 * Ported faithfully from the FRN-local `app/services/letterEditService.js`
 * (_applyEdit + _findAnchorWithFallback + _detectHeaderRename) — the Kenoly-hardened
 * logic. The surgical-AI endpoint's LLM proposes a STRUCTURED edit
 * ({operation, anchor_text, new_text}); this applies it deterministically, with
 * anchor-fallback (A exact → B whitespace → C header-rename → D dash-removal) and the
 * locked-block + placeholder safety guards. No LLM here — pure + unit-testable.
 */

import { cleanProseForSave } from './letter-sanity.js';
import { LOCKED_FRAGMENT_STRINGS as LOCKED_FRAGMENTS } from './letter-locked-blocks.js';

const PLACEHOLDER_RE = /\[\s*(?:VERIFY|TODO|PLACEHOLDER|FIXME|NEEDS|INSERT|FILL[ _]IN|CITATION NEEDED|TBD|XXX|FIX_ME)\b[^\]]*\]/i;

export type EditOperation = 'replace' | 'insert_after' | 'insert_before';

export interface EditProposal {
  operation: EditOperation;
  anchor_text: string;
  new_text: string;
}

export type ApplyResult =
  | { ok: true; newText: string; anchor_fallback: string | null; effective_anchor: string | null; effective_new_text: string | null }
  | { ok: false; error: string };

interface AnchorMatch {
  found: boolean;
  effective_anchor: string | null;
  effective_new_text: string | null;
  fallback: string | null;
}

interface HeaderRename {
  oldHeader: string;
  newHeader: string;
  numeral: string;
}

// Section-header-rename pattern: anchor + new_text both start with the same roman-numeral
// header (e.g. "**VII.**" → "**VII. Opinion**"). Returns the headers if matched.
function detectHeaderRename(anchorText: string, newText: string): HeaderRename | null {
  const headerRe = /^(\*\*(?:VIII|VII|VI|IV|V|III|II|I)\.(?:\s+[^*\n]*?)?\*\*)/;
  const aMatch = anchorText.match(headerRe);
  const nMatch = newText.match(headerRe);
  if (aMatch === null || nMatch === null) return null;
  const oldHeader = aMatch[1];
  const newHeader = nMatch[1];
  if (oldHeader === newHeader) return null;
  const aNum = oldHeader.match(/(VIII|VII|VI|IV|V|III|II|I)/);
  const nNum = newHeader.match(/(VIII|VII|VI|IV|V|III|II|I)/);
  if (aNum === null || nNum === null || aNum[1] !== nNum[1]) return null;
  return { oldHeader, newHeader, numeral: aNum[1] };
}

function findAnchorWithFallback(oldText: string, anchorText: string, newText: string, operation: EditOperation): AnchorMatch {
  // A. Exact match
  if (oldText.includes(anchorText)) {
    return { found: true, effective_anchor: anchorText, effective_new_text: null, fallback: null };
  }
  // B. Whitespace-normalized
  const wsVariants = [
    anchorText.replace(/\r\n/g, '\n'),
    anchorText.replace(/\n/g, '\r\n'),
    anchorText.replace(/\n\n+/g, '\n\n'),
    anchorText.replace(/[ \t]+$/gm, ''),
    anchorText.trim(),
    anchorText.replace(/\s+/g, ' '),
  ];
  for (const variant of wsVariants) {
    if (variant !== anchorText && variant.length >= 6 && oldText.includes(variant)) {
      return { found: true, effective_anchor: variant, effective_new_text: null, fallback: 'whitespace_normalized' };
    }
  }
  // C. Section-header-rename — REPLACE only, anchor must be unique.
  if (operation === 'replace' && newText) {
    const header = detectHeaderRename(anchorText, newText);
    if (header !== null && oldText.includes(header.oldHeader)) {
      let count = 0;
      let pos = 0;
      while ((pos = oldText.indexOf(header.oldHeader, pos)) !== -1) {
        count++;
        if (count > 1) break;
        pos += header.oldHeader.length;
      }
      if (count === 1) {
        return { found: true, effective_anchor: header.oldHeader, effective_new_text: header.newHeader, fallback: `header_rename_${header.numeral}` };
      }
    }
  }
  // D. Dash-separator removal with intermediate content (Kenoly v7).
  if (operation === 'replace' && newText) {
    let prefixLen = 0;
    const minLen = Math.min(anchorText.length, newText.length);
    while (prefixLen < minLen && anchorText.charAt(prefixLen) === newText.charAt(prefixLen)) prefixLen++;
    let suffixLen = 0;
    while (
      suffixLen < Math.min(anchorText.length - prefixLen, newText.length - prefixLen) &&
      anchorText.charAt(anchorText.length - 1 - suffixLen) === newText.charAt(newText.length - 1 - suffixLen)
    ) {
      suffixLen++;
    }
    const prefix = anchorText.substring(0, prefixLen);
    const suffix = anchorText.substring(anchorText.length - suffixLen);
    const removedFromAnchor = anchorText.substring(prefixLen, anchorText.length - suffixLen);
    const addedToNewText = newText.substring(prefixLen, newText.length - suffixLen);
    const dashOnly = /^[\s\n]*-{3,}[\s\n]*$/.test(removedFromAnchor);
    if (dashOnly && addedToNewText.trim() === '' && prefix.length >= 15 && suffix.length >= 6) {
      const pStart = oldText.indexOf(prefix);
      if (pStart !== -1) {
        const sStart = oldText.indexOf(suffix, pStart + prefix.length);
        if (sStart !== -1 && sStart - (pStart + prefix.length) < 10000) {
          const between = oldText.substring(pStart + prefix.length, sStart);
          const cleaned = between
            .replace(/\n\n+---+\n\n+/g, '\n\n')
            .replace(/^\s*---+\s*\n+/g, '')
            .replace(/\n+\s*---+\s*$/g, '');
          if (cleaned !== between) {
            return { found: true, effective_anchor: prefix + between + suffix, effective_new_text: prefix + cleaned + suffix, fallback: 'dash_removal_with_intermediate_content' };
          }
        }
      }
    }
  }
  return { found: false, effective_anchor: null, effective_new_text: null, fallback: null };
}

/**
 * Apply one structured surgical edit to the letter text. Returns the new text or a
 * descriptive error (for the LLM-retry loop). new_text is auto-cleaned (em dashes / smart
 * quotes) first. Refuses to delete/mutate a locked block or introduce a placeholder token.
 */
export function applyStructuredEdit(oldText: string, proposal: EditProposal): ApplyResult {
  const operation = proposal.operation;
  const anchor_text = proposal.anchor_text;
  const new_text = cleanProseForSave(proposal.new_text);
  if (!operation || !anchor_text || new_text == null) {
    return { ok: false, error: 'edit proposal missing required fields (operation, anchor_text, new_text)' };
  }

  const anchorMatch = findAnchorWithFallback(oldText, anchor_text, new_text, operation);
  if (!anchorMatch.found || anchorMatch.effective_anchor === null) {
    return { ok: false, error: 'anchor_text not found in current draft — try a shorter, more distinctive substring or quote the literal text from the draft' };
  }
  const effectiveAnchor = anchorMatch.effective_anchor;
  const effectiveNewText = anchorMatch.effective_new_text ?? new_text;

  for (const locked of LOCKED_FRAGMENTS) {
    if (!effectiveAnchor.includes(locked)) continue;
    if (!effectiveNewText.includes(locked)) {
      return { ok: false, error: `edit would delete or mutate a locked block — refuse. Locked phrase "${locked.substring(0, 60)}..." present in anchor but ABSENT from new_text. Locked blocks (Section I credentials, Section II Nieves paragraph) must survive verbatim.` };
    }
  }

  if (PLACEHOLDER_RE.test(effectiveNewText)) {
    const m = effectiveNewText.match(PLACEHOLDER_RE);
    return { ok: false, error: `new_text contains a bracketed scaffolding token: "${m && m[0] ? m[0].slice(0, 100) : '[VERIFY ...]'}". TODO markers must not appear in letter prose. UNBYPASSABLE.` };
  }

  let newText: string;
  if (operation === 'replace') {
    newText = oldText.replace(effectiveAnchor, effectiveNewText);
  } else if (operation === 'insert_after') {
    newText = oldText.replace(effectiveAnchor, `${effectiveAnchor} ${effectiveNewText}`);
  } else if (operation === 'insert_before') {
    newText = oldText.replace(effectiveAnchor, `${effectiveNewText} ${effectiveAnchor}`);
  } else {
    return { ok: false, error: `unknown operation: ${String(operation)}` };
  }

  return {
    ok: true,
    newText,
    anchor_fallback: anchorMatch.fallback,
    effective_anchor: effectiveAnchor !== anchor_text ? effectiveAnchor : null,
    effective_new_text: anchorMatch.effective_new_text ?? null,
  };
}
