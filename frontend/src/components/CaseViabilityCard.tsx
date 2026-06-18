import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCaseViability } from '../api/case-viability';
import { StatusChip } from './ui/StatusChip';
import { SectionCard } from './ui/SectionCard';
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
  const [openBridges, setOpenBridges] = useState<ReadonlySet<number>>(new Set());

  const v = q.data?.data;
  if (!v) return null; // dark flag / fail-open / loading — the flag controls the whole surface

  const best = v.best_anchor;
  const ra = v.recommended_action;
  // BAND-LEAK / OVER-CALL GUARD (2026-06-18): the resolver's recommendedAction already routes an
  // UNREVIEWED (physician_reviewed:false) mechanism to physician review regardless of band — 94.5% of
  // the table is Doximity-sourced. We CONSUME that decision (we do not re-derive it): when the policy
  // says escalate→physician AND the row is unreviewed AND the band would otherwise read green
  // (strong/moderate/conditional), the headline must NOT say "Strong" — it is a CANDIDATE pathway that
  // needs physician confirmation of the medicine. Fail-open: no recommended_action → legacy band chip.
  const greenBand = v.viability === 'strong' || v.viability === 'moderate' || v.viability === 'conditional';
  const unreviewedOvercall =
    greenBand && best?.physician_reviewed === false && ra?.action === 'escalate' && ra?.route === 'physician';
  const chip = unreviewedOvercall
    ? { tone: 'warn' as const, label: 'Candidate — physician review' }
    : BAND_CHIP[v.viability];

  return (
    <SectionCard
      title="Anchor viability"
      status={
        <StatusChip tone={chip.tone} className="shrink-0">
          <span title="Advisory only — does not block drafting; Gate-2 supersedes on any contradiction">{chip.label}</span>
        </StatusChip>
      }
    >
      {best ? (
        <div className="text-sm text-slate-800">
          <span className="font-medium">{best.upstream_verbatim}</span>
          {' → '}
          {v.claimed_canonical ?? '—'}
          <span className="ml-1 text-slate-500">
            (M{best.M_eff ?? '–'} {best.tier}{best.E === null ? ', E: not yet scored' : `, E: ${best.E}`})
          </span>
        </div>
      ) : null}
      {/* OVER-CALL GUARD badge — the mechanism is a candidate, not a physician-reviewed "recognized
          cause". Renders the resolver's own reason verbatim so the panel and Ask Aegis say the same thing. */}
      {unreviewedOvercall ? (
        <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
          <span className="font-medium">Not yet physician-reviewed.</span>{' '}
          {ra?.reason ?? 'Candidate pathway — confirm the medicine with the physician before drafting.'}
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
        <div className="mt-3 space-y-2">
          {v.bridge_pathways!.map((b, i) => {
            const open = openBridges.has(i);
            const toggle = () => setOpenBridges((prev) => {
              const next = new Set(prev);
              if (next.has(i)) next.delete(i); else next.add(i);
              return next;
            });
            return (
              <div key={`${b.intermediate_dx}-${b.claimed}-${i}`} className="rounded-md border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 text-sm text-slate-800">
                    <span className="font-medium">Possible bridge:</span> {b.intermediate_dx} → {b.claimed}
                  </div>
                  {b.physician_review_required ? (
                    <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      Physician review
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Presumptive basis: {b.intermediate_presumptive_basis}
                  {b.pair_tier ? ` · pairing: ${b.pair_tier}` : ''}
                </div>
                <button type="button" onClick={toggle} className="mt-1 text-xs text-slate-400 hover:text-slate-600">
                  {open ? 'Hide details ▲' : 'Details ▾'}
                </button>
                {/* Verbatim engine copy (collapsed by default — calm/neutral). whitespace-pre-line preserves structure. */}
                {open ? <p className="mt-2 whitespace-pre-line text-sm text-slate-600">{b.suggestion}</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </SectionCard>
  );
}
