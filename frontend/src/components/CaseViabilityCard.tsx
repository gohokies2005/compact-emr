import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCaseViability } from '../api/case-viability';
import { StatusChip } from './ui/StatusChip';
import { BAND_CHIP } from '../lib/viabilityChip';
import { CompletenessSignal, type CompletenessState } from './ViabilityInputSet';

// RN anchor-viability panel (build plan §4.3) — pattern-mirrors StrategyPreviewCard: advisory only,
// never wears a blocker color, never gates the Send-to-Drafter button (Gate-2 SUPERSEDES it on any
// contradiction). Audience is RN/physician-internal: M_eff / tier / E are fine here; a BVA %, IMO
// rate, pair-atlas tier number, or the word "pair-atlas" is NEVER rendered (CLAUDE.md #17 — the
// guard is structural in the resolver; this card adds no numbers of its own).
//
// DARK surface: the GET returns { data: null } while EMR_CASE_VIABILITY_ENABLED is off (and on a
// failed-open read) → the card renders nothing. info-light only (no chart facts yet, G9):
// `confidence` is a band/mode signal, NOT a physician-review attestation (R6) — no "physician
// reviewed" wording appears here.

// BAND_CHIP moved to lib/viabilityChip.ts (P1 2026-06-11) — one map shared with StrategyPreviewCard.

export function CaseViabilityCard({
  caseId,
  completeness,
}: {
  readonly caseId: string;
  // E5 (2026-06-13): how much of the record went unparsed, threaded from SendToDrafterPanel — a thin
  // parse must never masquerade as a confident anchor verdict. Undefined = caller didn't supply it.
  readonly completeness?: CompletenessState | null;
}) {
  const q = useQuery({
    queryKey: ['case', caseId, 'viability-card'],
    queryFn: () => getCaseViability(caseId),
    enabled: caseId.length > 0,
  });
  const [showTraps, setShowTraps] = useState(false);

  const v = q.data?.data;
  if (!v) return null; // dark flag / fail-open / loading — the flag controls the whole surface

  const chip = BAND_CHIP[v.viability];
  const best = v.best_anchor;

  return (
    <div className="mb-5 border-b border-aegis pb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-navyDeep">Anchor viability</div>
          {best ? (
            <div className="mt-1 text-sm text-slate-800">
              <span className="font-medium">{best.upstream_verbatim}</span>
              {' → '}
              {v.claimed_canonical ?? '—'}
              <span className="ml-1 text-slate-500">
                (M{best.M_eff ?? '–'} {best.tier}{best.E === null ? ', E: not yet scored' : `, E: ${best.E}`})
              </span>
            </div>
          ) : null}
          <div className="mt-1 text-sm text-slate-600">{v.why}</div>
          {v.missing_fact ? (
            <div className="mt-1 text-sm text-amber-700">
              <span className="font-medium">To strengthen:</span> {v.missing_fact}
            </div>
          ) : null}
          {v.presumptive_redirect ? (
            <div className="mt-1 text-sm text-slate-600">
              <span className="font-medium">Consider presumptive:</span> {v.presumptive_redirect.note}
            </div>
          ) : null}
          {v.graveyard_redirect ? (
            <div className="mt-1 text-sm text-slate-600">
              <span className="font-medium">Redirect:</span> argue {v.graveyard_redirect.redirect_to} instead of {v.graveyard_redirect.dead_anchor}.
            </div>
          ) : null}
          {v.alternatives.length > 0 ? (
            <div className="mt-1 text-xs text-slate-500">
              Other eligible anchors: {v.alternatives.map((a) => `${a.upstream_canonical} (M${a.M_eff ?? '–'})`).join(', ')}
            </div>
          ) : null}
          {/* E5 COMPLETENESS SIGNAL — a thin parse must never masquerade as a confident anchor verdict. */}
          <CompletenessSignal state={completeness ?? null} />
        </div>
        <StatusChip tone={chip.tone} className="shrink-0">
          <span title="Advisory only — does not block drafting; Gate-2 supersedes on any contradiction">{chip.label}</span>
        </StatusChip>
      </div>

      {v.excluded_traps.length > 0 ? (
        <>
          <button type="button" onClick={() => setShowTraps((s) => !s)} className="mt-2 text-xs text-slate-400 hover:text-slate-600">
            {showTraps ? 'Why not these anchors ▲' : `Why not these anchors (${v.excluded_traps.length}) ▼`}
          </button>
          {showTraps ? (
            <ul className="mt-2 space-y-1">
              {v.excluded_traps.map((t) => (
                <li key={t.upstream_canonical} className="text-xs text-slate-600">
                  <span className="font-medium">{t.upstream_canonical}:</span> {t.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {/* BRIDGE-ANCHOR (2026-06-16): a provisional two-hop SUGGESTION (exposure → PACT-presumptive
          intermediate dx → claimed secondary), NOT a viability band — rendered as a visually distinct
          "suggested next step" block. The `suggestion` string is FINAL FRN-engine copy: rendered
          VERBATIM (no re-templating, no BVA %/odds). RN-only surface; physician_review_required is
          surfaced as a badge. Present only when the engine fires a fully fact-gated bridge. */}
      {(v.bridge_pathways?.length ?? 0) > 0 ? (
        <div className="mt-3 space-y-3">
          {v.bridge_pathways!.map((b, i) => (
            <div key={`${b.intermediate_dx}-${b.claimed}-${i}`} className="rounded-md border border-sky-200 bg-sky-50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-sm font-medium text-sky-900">
                  Possible bridge pathway: <span className="font-semibold">{b.intermediate_dx}</span> → {b.claimed}
                </div>
                {b.physician_review_required ? (
                  <span className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                    Physician review required
                  </span>
                ) : null}
              </div>
              <div className="mt-1 text-xs text-sky-800">
                Presumptive basis: {b.intermediate_presumptive_basis}
                {b.pair_tier ? <span className="ml-2 text-sky-700">· second-hop pairing: {b.pair_tier}</span> : null}
              </div>
              {/* Verbatim engine copy — whitespace-pre-line preserves any intentional structure. */}
              <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{b.suggestion}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
