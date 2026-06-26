import { describe, it, expect } from 'vitest';
import {
  authorityTierForDocType,
  authorityTierForDocument,
  scStatusAuthoritativeFor,
  effectiveScStatus,
} from '../services/sc-authority.js';
import { buildGrantedScAnchors } from '../services/case-framing.js';

describe('sc-authority — source-authority classification (Woodley fix)', () => {
  describe('authorityTierForDocType', () => {
    it('VA rating decisions are authoritative', () => {
      expect(authorityTierForDocType('rating_decision')).toBe('va_decision');
      expect(authorityTierForDocType('supplemental_decision')).toBe('va_decision');
      expect(authorityTierForDocType('rated_disabilities_view')).toBe('va_decision');
      expect(scStatusAuthoritativeFor('va_decision')).toBe(true);
    });
    it('benefit summary / denial letter are authoritative (va_summary)', () => {
      expect(authorityTierForDocType('benefit_summary')).toBe('va_summary');
      expect(authorityTierForDocType('denial_letter')).toBe('va_summary');
      expect(scStatusAuthoritativeFor('va_summary')).toBe(true);
    });
    it('clinical docs are NOT SC-status-authoritative', () => {
      expect(authorityTierForDocType('c_and_p_exam')).toBe('clinical');
      expect(authorityTierForDocType('progress_notes')).toBe('clinical');
      expect(scStatusAuthoritativeFor('clinical')).toBe(false);
    });
    it('veteran/lay/intake docs are NON-authoritative', () => {
      expect(authorityTierForDocType('statement_in_support')).toBe('veteran_or_lay');
      expect(authorityTierForDocType('lay_statement')).toBe('veteran_or_lay');
      expect(authorityTierForDocType('intake_summary')).toBe('veteran_or_lay');
      expect(scStatusAuthoritativeFor('veteran_or_lay')).toBe(false);
    });
    it('unknown/structural docTypes fail-safe to non-authoritative', () => {
      expect(authorityTierForDocType('unspecified')).toBe('unknown');
      expect(authorityTierForDocType('dd_214')).toBe('unknown');
      expect(authorityTierForDocType(null)).toBe('unknown');
      expect(scStatusAuthoritativeFor('unknown')).toBe(false);
    });
  });

  describe('authorityTierForDocument fingerprint (when docType is missing/unspecified)', () => {
    it('the WOODLEY goal-doc is NON-authoritative (a .docx with goal framing)', () => {
      const tier = authorityTierForDocument({
        docType: 'unspecified',
        filename: 'Woodley_GERD_Misc_4.docx',
        textSample: 'Goals: 30% – Recurrent esophageal stricture (DC 7203/7346); 10% – GERD',
      });
      expect(tier).toBe('veteran_or_lay');
      expect(scStatusAuthoritativeFor(tier)).toBe(false);
    });
    it('a real VA rating decision is authoritative by header + decision recital', () => {
      const tier = authorityTierForDocument({
        docType: 'unspecified',
        filename: 'scan_017.pdf',
        textSample: 'DEPARTMENT OF VETERANS AFFAIRS\nRating Decision\nDECISION: Service connection for tinnitus is granted with an evaluation of 10 percent.',
      });
      expect(tier).toBe('va_decision');
      expect(scStatusAuthoritativeFor(tier)).toBe(true);
    });
    it('a personal statement is non-authoritative even without a docType', () => {
      expect(authorityTierForDocument({ filename: 'personal_statement.pdf', textSample: 'I am claiming service connection for my back.' })).toBe('veteran_or_lay');
    });
    it('an unidentifiable doc fails safe to unknown (non-authoritative)', () => {
      expect(authorityTierForDocument({ filename: 'misc_scan.pdf', textSample: 'page 1 of 40' })).toBe('unknown');
    });
  });

  describe('effectiveScStatus trust gate (CONSERVATIVE — demote only PROVEN-junk tier)', () => {
    // The .docx goal-doc tier = veteran_or_lay (PROVEN the veteran's own assertion) → demotes.
    const woodleyRow = { status: 'service_connected', source: 'extracted', scStatusAuthoritative: false, sourceAuthorityTier: 'veteran_or_lay' };

    it('DARK (flag off): a non-authoritative extracted grant is NOT demoted (byte-identical)', () => {
      expect(effectiveScStatus(woodleyRow, { enforce: false })).toBe('service_connected');
    });
    it('ENFORCED: a PROVEN-junk (veteran_or_lay) extracted grant demotes to claimed_unverified', () => {
      expect(effectiveScStatus(woodleyRow, { enforce: true })).toBe('claimed_unverified');
    });
    it('CONSERVATIVE: an UNCONFIRMED grant (unknown/clinical — e.g. an image/Misc file) is KEPT when enforcing, NOT stripped (the over-filter fix)', () => {
      expect(effectiveScStatus({ status: 'service_connected', source: 'extracted', scStatusAuthoritative: false, sourceAuthorityTier: 'unknown' }, { enforce: true })).toBe('service_connected');
      expect(effectiveScStatus({ status: 'service_connected', source: 'extracted', scStatusAuthoritative: false, sourceAuthorityTier: 'clinical' }, { enforce: true })).toBe('service_connected');
    });
    it('ENFORCED: an AUTHORITATIVE extracted grant stays service_connected', () => {
      expect(effectiveScStatus({ status: 'service_connected', source: 'extracted', scStatusAuthoritative: true, sourceAuthorityTier: 'va_decision' }, { enforce: true })).toBe('service_connected');
    });
    it('ENFORCED: a MANUAL (RN-typed) grant is always trusted', () => {
      expect(effectiveScStatus({ status: 'service_connected', source: 'manual', scStatusAuthoritative: null, sourceAuthorityTier: null }, { enforce: true })).toBe('service_connected');
    });
    it('ENFORCED: a legacy extracted grant with NULL tier is TRUSTED until re-classified (safe incremental flip)', () => {
      expect(effectiveScStatus({ status: 'service_connected', source: 'extracted', scStatusAuthoritative: null, sourceAuthorityTier: null }, { enforce: true })).toBe('service_connected');
    });
    it('pending / denied are untouched in both modes', () => {
      for (const enforce of [true, false]) {
        expect(effectiveScStatus({ status: 'pending', source: 'extracted' }, { enforce })).toBe('pending');
        expect(effectiveScStatus({ status: 'denied', source: 'extracted' }, { enforce })).toBe('denied');
      }
    });
  });

  // ── THE WOODLEY REGRESSION (headline): a non-authoritative service_connected must NEVER become a
  // granted secondary primary, so the drafter cannot argue a nexus off a fake grant. ──────────────────
  describe('buildGrantedScAnchors — provenance gate (Woodley)', () => {
    const claimed = 'GERD';
    const woodleyFakeGrant = { condition: 'Recurrent esophageal stricture', ratingPct: 30, status: 'service_connected', source: 'extracted', scStatusAuthoritative: false, sourceAuthorityTier: 'veteran_or_lay' };
    const realGrant = { condition: 'PTSD', ratingPct: 70, status: 'service_connected', source: 'extracted', scStatusAuthoritative: true, sourceAuthorityTier: 'va_decision' };

    it('ENFORCED: a non-authoritative SC grant (Woodley goal-doc) is EXCLUDED from the anchors', () => {
      const anchors = buildGrantedScAnchors([woodleyFakeGrant, realGrant], claimed, { enforce: true });
      const names = anchors.map((a) => a.condition);
      expect(names).toContain('PTSD'); // the authoritative grant anchors
      expect(names).not.toContain('Recurrent esophageal stricture'); // the fake grant does NOT
    });

    it('DARK (flag off): byte-identical to the legacy strict filter (both grants anchor)', () => {
      const anchors = buildGrantedScAnchors([woodleyFakeGrant, realGrant], claimed, { enforce: false });
      const names = anchors.map((a) => a.condition);
      expect(names).toContain('PTSD');
      expect(names).toContain('Recurrent esophageal stricture'); // legacy behavior unchanged
    });

    it('a MANUAL (RN-typed) grant anchors even when enforcing', () => {
      const manual = { condition: 'Tinnitus', ratingPct: 10, status: 'service_connected', source: 'manual', scStatusAuthoritative: null };
      const anchors = buildGrantedScAnchors([manual], claimed, { enforce: true });
      expect(anchors.map((a) => a.condition)).toContain('Tinnitus');
    });
  });
});
