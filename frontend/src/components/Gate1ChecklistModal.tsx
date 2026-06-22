import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { postGate1Attestations } from '../api/drafter';
import { getDraftReadiness, type ReadinessItem } from '../api/draft-readiness';
import { describeApiError } from '../api/client';

type Answer = 'yes' | 'no' | 'override' | 'not_applicable';
interface Item { readonly key: string; readonly label: string; readonly allowNA?: boolean }

/**
 * Gate-1 "Before we draft" checklist (human attestation; no AI). Fires when the RN starts a draft.
 * Every shown item must be Yes, Override+reason, or (SC-conditions) Not applicable. A "No" blocks
 * with a one-line next step. Attestations are written to the chart (draft_decisions, gate=1) BEFORE
 * the draft is enqueued. Gate-2 (the AI dx/event check) is the backstop for a lazy attestation.
 *
 * PRE-FILL (work order Task 3, audit D1 — "the dropdown checklist reads nothing"): the modal seeds
 * its answers from the draft-readiness GET (the document-level evidence + the SSOT caseFraming), so
 * the RN confirms findings WITH the evidence shown instead of attesting blind. The RN still writes
 * the attestation — every radio stays editable, present-evidence pre-selects Yes, ABSENT evidence
 * deliberately leaves the radio UNSET (a prompt to decide, never an auto-"No" that trains bulk
 * overriding). Feed absent / chart still building → byte-identical blank modal (fail-open).
 */

// readiness item key → Gate-1 checklist item key
const READINESS_TO_GATE1: Record<string, string> = {
  current_diagnosis: 'dx_present',
  in_service_event: 'in_service_event',
  sc_conditions: 'sc_conditions',
  denial_letter: 'prior_denial',
};

const SOURCE_LABEL: Record<string, string> = {
  rn_set: 'set by RN',
  derived: 'auto-derived from the granted SC conditions',
  text_parse_fallback: 'parsed from the veteran’s intake wording',
  // #6 (2026-06-21): the default-fallback source means NO framing was derived — it is not a real "direct"
  // decision. Showing "default (direct)" misleads the RN into thinking a direct theory was chosen. When there
  // is no route-picker plan grounding the readiness, this is the neutral, honest label.
  default_direct: 'framing not yet computed',
};
export function Gate1ChecklistModal({ caseId, claimType, claimedCondition, draftAttempt, onConfirmed, onClose }: {
  readonly caseId: string;
  readonly claimType: string;
  readonly claimedCondition: string;
  readonly draftAttempt: number;
  // Receives the optional free-text drafting guidance the RN typed (→ strategyOverride on the draft).
  readonly onConfirmed: (guidance?: string) => void;
  readonly onClose: () => void;
}) {
  const items = useMemo<Item[]>(() => {
    const base: Item[] = [
      { key: 'in_service_event', label: 'An in-service event, injury, or exposure is documented in the records.' },
      { key: 'dx_present', label: `Current records show a diagnosis of ${claimedCondition || 'the claimed condition'}.` },
      { key: 'sc_conditions', label: "The veteran's established service-connected conditions are documented (a VA letter or Blue Button report is in the file).", allowNA: true },
    ];
    if (['supplemental', 'hlr', 'appeal', 'appeal_bva'].includes(claimType)) {
      base.push({ key: 'prior_denial', label: 'The prior denial letter(s) are included in the files.' });
    }
    return base;
  }, [claimType, claimedCondition]);

  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [guidance, setGuidance] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // The pre-fill feed. Loading/error/still-building all degrade to today's blank modal.
  const readinessQuery = useQuery({
    queryKey: ['case', caseId, 'draft-readiness'],
    queryFn: () => getDraftReadiness(caseId),
    enabled: caseId.length > 0,
  });
  const readiness = readinessQuery.data?.data;

  const byGate1Key = useMemo(() => {
    const m: Record<string, ReadinessItem> = {};
    if (readiness?.buildState === 'chart_ready') {
      for (const it of readiness.items ?? []) {
        const g = READINESS_TO_GATE1[it.key];
        if (g !== undefined) m[g] = it;
      }
    }
    return m;
  }, [readiness]);

  // One-shot seed: present evidence pre-selects Yes; the merge keeps any answer the RN already
  // clicked ({...seed, ...prev} — prev wins), and the ref stops a background refetch re-seeding
  // over an RN who cleared a box. Both are load-bearing (architect plan risk 3).
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (readiness?.buildState !== 'chart_ready') return;
    const seed: Record<string, Answer> = {};
    for (const i of items) {
      const ev = byGate1Key[i.key];
      if (ev !== undefined && ev.present) seed[i.key] = 'yes';
    }
    if (Object.keys(seed).length > 0) setAnswers((prev) => ({ ...seed, ...prev }));
    seededRef.current = true;
  }, [readiness, items, byGate1Key]);

  const anyNo = items.some((i) => answers[i.key] === 'no');
  const allResolved = items.every((i) => {
    const a = answers[i.key];
    if (a === 'yes' || a === 'not_applicable') return true;
    if (a === 'override') return (reasons[i.key] ?? '').trim().length > 0;
    return false;
  });

  async function confirm() {
    if (!allResolved || anyNo) return;
    setSubmitting(true);
    try {
      await postGate1Attestations(caseId, draftAttempt, items.map((i) => ({
        item: i.key,
        decision: answers[i.key]!,
        ...(answers[i.key] === 'override' ? { reason: (reasons[i.key] ?? '').trim() } : {}),
      })));
      onConfirmed(guidance.trim() || undefined);
    } catch (e) {
      window.alert(`Could not record the checklist — ${describeApiError(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true">
      <div className="fixed inset-0 z-40 bg-slate-900/50" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-6 shadow-2xl" style={{ maxHeight: '85vh' }}>
        <h2 className="text-base font-semibold text-slate-900">Before we draft</h2>
        <p className="mt-1 text-sm text-slate-500">Confirm each item before starting the draft.</p>
        {/* The REASONED framing from the route-picker plan (the SAME brain the drafter pleads) — shown instead
            of the bare SSOT label / "default (direct)" when a plan is available. Falls back to the SSOT
            caseFraming label when no plan grounds the readiness (flag off / no plan / chart still building). */}
        {readiness?.routePlan !== undefined ? (
          <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <p>Plan framing: <span className="font-semibold text-slate-800">{readiness.routePlan.framing}</span>
              {readiness.routePlan.cfr_basis ? <> · {readiness.routePlan.cfr_basis}</> : null}</p>
            {readiness.routePlan.rationale ? <p className="mt-0.5">{readiness.routePlan.rationale}</p> : null}
          </div>
        ) : readiness?.caseFraming !== undefined ? (
          <p className="mt-1 text-xs text-slate-500">
            Framing: <span className="font-semibold">{readiness.caseFraming.framing}</span>
            {' · '}{SOURCE_LABEL[readiness.caseFraming.source] ?? readiness.caseFraming.source}
            {readiness.caseFraming.upstreamScCondition !== null ? <> · anchor: {readiness.caseFraming.upstreamScCondition}</> : null}
          </p>
        ) : null}
        <div className="mt-4 space-y-4">
          {items.map((i) => (
            <div key={i.key} className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm text-slate-800">{i.label}</p>
              {byGate1Key[i.key] !== undefined ? (
                <p className={`mt-1 text-xs ${byGate1Key[i.key]!.present ? 'text-emerald-700' : 'text-amber-700'}`}>
                  <span aria-hidden="true">{byGate1Key[i.key]!.present ? '✓ ' : '⚠ '}</span>
                  {byGate1Key[i.key]!.present ? byGate1Key[i.key]!.basis : (byGate1Key[i.key]!.message ?? byGate1Key[i.key]!.basis)}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                {(['yes', 'no', 'override', ...(i.allowNA ? ['not_applicable'] as Answer[] : [])] as Answer[]).map((opt) => (
                  <label key={opt} className="flex items-center gap-1">
                    <input type="radio" name={i.key} checked={answers[i.key] === opt} onChange={() => setAnswers((p) => ({ ...p, [i.key]: opt }))} />
                    {opt === 'not_applicable' ? 'Not applicable' : opt === 'override' ? 'Override' : opt === 'yes' ? 'Yes' : 'No'}
                  </label>
                ))}
              </div>
              {answers[i.key] === 'override' ? (
                <input className="input mt-2 w-full text-sm" placeholder="Reason (required for override)" value={reasons[i.key] ?? ''} onChange={(e) => setReasons((p) => ({ ...p, [i.key]: e.target.value }))} />
              ) : null}
            </div>
          ))}
        </div>
        <label className="mt-4 block">
          <span className="text-sm font-medium text-slate-800">Drafting guidance <span className="font-normal text-slate-400">(optional)</span></span>
          <span className="mt-0.5 block text-xs text-slate-500">Steer the approach — the drafter still grounds every claim in the records and literature.</span>
          <textarea
            className="input mt-1 min-h-20 w-full text-sm"
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            placeholder="e.g. Focus on PTSD as the primary cause given stronger viability; mention GERD as a secondary contributor."
          />
        </label>
        {anyNo ? (
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">Retrieve those records or discuss with the veteran, then come back. The draft won&apos;t start with a &quot;No&quot;.</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!allResolved || anyNo || submitting} loading={submitting} onClick={() => void confirm()}>Start draft</Button>
        </div>
      </div>
    </div>
  );
}
