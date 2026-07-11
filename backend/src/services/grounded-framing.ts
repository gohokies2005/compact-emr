// Grounded framing/upstream resolver (Ryan 2026-07-11, CLM-47FAC163B8 "ANKLE nowhere"; 3-agent QA).
//
// `Case.upstreamScCondition`/`framingChoice` are AUTO-DERIVED by a mechanism-blind Board-pair matcher and
// can be STALE/WRONG (Jay: "Ankle" while the statement + route-picker plan + letter all say depression).
// This resolves the anchor that is SAFE TO DISPLAY, so a stale guess never reaches any chart surface:
//   1. framingStampSource==='manual'  → trust the stored field (an RN chose it deliberately).
//   2. else the GATED, READY-only route-picker plan (getAiViabilityState — on-condition + fresh-hash +
//      status:'ready'; NEVER the raw aiViabilityPlanJson blob, which is never nulled on error and for a
//      DIRECT claim can carry a raw route-picker sentinel key — AI-SME QA S1) → its lead upstream, but
//      ONLY when the lead is a secondary/aggravation anchor with a real upstream.
//   3. else a `derived` stored value is an UNVERIFIABLE mechanism-blind guess → SUPPRESS to null (never
//      show "Ankle"). A non-`derived` stored value (legacy/unknown source) is left as-is (can't do better).
//
// It is DISPLAY-layer only: it changes what SURFACES show/seed, never the raw DB column, so the drafter
// (which reads the raw column via drafter-bundle, not this) is untouched. Fail-open: any error → the
// stored value is suppressed if derived, else kept.
import { getAiViabilityState } from './ai-viability.js';
import type { AppDb } from './db-types.js';

export type GroundedFramingSource = 'manual' | 'grounded' | 'stored' | 'suppressed';

export interface GroundedFraming {
  /** The upstream SC condition SAFE to display (null when suppressed / none). */
  readonly upstream: string | null;
  /** The framing SAFE to display (secondary/aggravation/direct/…), or the stored value. */
  readonly framing: string | null;
  readonly source: GroundedFramingSource;
}

export interface StoredFramingFields {
  readonly framingStampSource?: string | null;
  readonly framingChoice?: string | null;
  readonly upstreamScCondition?: string | null;
}

function bucket(f: string | null | undefined): 'secondary' | 'aggravation' | 'direct' | 'other' {
  const n = (f ?? '').toLowerCase();
  if (n.includes('secondary')) return 'secondary';
  if (n.includes('aggrav')) return 'aggravation';
  if (n.includes('direct')) return 'direct';
  return 'other';
}

export async function resolveGroundedFraming(db: AppDb, caseId: string, stored: StoredFramingFields): Promise<GroundedFraming> {
  const storedUpstream = (stored.upstreamScCondition ?? '').trim() || null;
  const storedFraming = (stored.framingChoice ?? '').trim() || null;
  const src = (stored.framingStampSource ?? '').toLowerCase();

  // Fast path (no extra read): RN-chosen framing is trusted; nothing to resolve when there's no upstream.
  if (src === 'manual') return { upstream: storedUpstream, framing: storedFraming, source: 'manual' };
  if (!storedUpstream) return { upstream: null, framing: storedFraming, source: 'stored' };

  const isDerived = src === 'derived';
  try {
    const state = await getAiViabilityState(db, caseId, { compute: false });
    if (state.status === 'ready') {
      const lead = state.card.lead;
      const leadUpstream = (lead.upstream ?? '').trim() || null;
      const leadFraming = (lead.framing ?? '').trim() || null;
      const leadBucket = bucket(leadFraming);
      // A usable grounded anchor is a secondary/aggravation lead WITH a real upstream (direct/abstain
      // leads have no secondary anchor and can carry sentinel keys — never display those).
      if (leadUpstream && (leadBucket === 'secondary' || leadBucket === 'aggravation')) {
        if (isDerived && storedUpstream.toLowerCase() !== leadUpstream.toLowerCase()) {
          console.log(JSON.stringify({ msg: 'grounded_upstream_override', caseId, from: storedUpstream, to: leadUpstream, source: 'grounded' }));
        }
        return { upstream: leadUpstream, framing: leadFraming, source: 'grounded' };
      }
      // ready but the lead is direct/empty → there is NO valid secondary anchor → suppress a derived guess.
      if (isDerived) {
        console.log(JSON.stringify({ msg: 'grounded_upstream_override', caseId, from: storedUpstream, to: null, source: 'suppressed_direct_lead' }));
        return { upstream: null, framing: leadFraming ?? storedFraming, source: 'suppressed' };
      }
      return { upstream: storedUpstream, framing: storedFraming, source: 'stored' };
    }
  } catch {
    // fall through to the no-plan branch (fail-open)
  }

  // No ready plan to corroborate against → a DERIVED value is an unverifiable mechanism-blind guess →
  // suppress it (Ryan: "ankle nowhere"). A non-derived value is left as-is.
  if (isDerived) {
    console.log(JSON.stringify({ msg: 'grounded_upstream_override', caseId, from: storedUpstream, to: null, source: 'suppressed_no_plan' }));
    return { upstream: null, framing: storedFraming, source: 'suppressed' };
  }
  return { upstream: storedUpstream, framing: storedFraming, source: 'stored' };
}
