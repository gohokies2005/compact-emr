import { useMemo, useState } from 'react';
import { Button } from './ui/Button';
import { postGate1Attestations } from '../api/drafter';
import { describeApiError } from '../api/client';

type Answer = 'yes' | 'no' | 'override' | 'not_applicable';
interface Item { readonly key: string; readonly label: string; readonly allowNA?: boolean; readonly primary?: boolean }

/**
 * Gate-1 "Before we draft" checklist — a PLAIN RN ATTESTATION (Dr. Kasky 2026-06-29). The human
 * verifies; the machine makes NO ✓/⚠ judgment. Every radio starts UNSET — the RN clicks Yes / No /
 * Override(+reason) / (Not applicable, where allowed). A "No" blocks; the draft starts only when every
 * item is resolved with no "No". Attestations are written to the chart (draft_decisions, gate=1)
 * BEFORE the draft is enqueued, so the human decision is on the record.
 *
 * RETIRED 2026-06-29: the deterministic pre-draft readiness auto-evaluation that pre-filled answers and
 * rendered "Essential documents missing: …" cautions. It over-fired (the exact-canonical dx match
 * false-flagged a documented clinically-equivalent condition as "diagnosis missing", ~90% of cautions
 * were wrong). The LLM SOAP note is now the analysis surface; THIS modal is purely the human's call.
 * The draft is gated by the RN completing this checklist (including the nexus judgment), not by any
 * machine string-match. See ARCHITECTURE.md SUPERSEDED log.
 */
export function Gate1ChecklistModal({ caseId, claimedCondition, draftAttempt, onConfirmed, onClose }: {
  readonly caseId: string;
  // claimType is still passed by callers (kept in the type for compatibility) but no longer changes
  // the checklist — the prior-denial item is always shown with a Not-applicable option instead.
  readonly claimType: string;
  readonly claimedCondition: string;
  readonly draftAttempt: number;
  // Receives the optional free-text drafting guidance the RN typed (→ strategyOverride on the draft).
  readonly onConfirmed: (guidance?: string) => void;
  readonly onClose: () => void;
}) {
  // Dr. Kasky's exact list. The first three are rote verification; the last is the human judgment call
  // the RNs are trained on (rendered as the highlighted primary question).
  const items = useMemo<Item[]>(() => [
    { key: 'dx_present', label: `A current diagnosis of ${claimedCondition || 'the claimed (or a clinically-equivalent)'} condition is in the records, with medical records supporting it.` },
    { key: 'sc_conditions', label: 'The relevant service-connected condition is documented in VA records (rating decision / Blue Button report).', allowNA: true },
    { key: 'prior_denial', label: 'Any prior denial letter(s) are in the file.', allowNA: true },
    { key: 'nexus_judgment', label: 'In your judgment, is there a plausible medical nexus to author here?', primary: true },
  ], [claimedCondition]);

  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [guidance, setGuidance] = useState('');
  const [submitting, setSubmitting] = useState(false);

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

  function radios(i: Item) {
    const opts: Answer[] = ['yes', 'no', 'override', ...(i.allowNA ? ['not_applicable'] as Answer[] : [])];
    return (
      <>
        <div className="mt-2 flex flex-wrap gap-3 text-sm">
          {opts.map((opt) => (
            <label key={opt} className="flex items-center gap-1">
              <input type="radio" name={i.key} checked={answers[i.key] === opt} onChange={() => setAnswers((p) => ({ ...p, [i.key]: opt }))} />
              {opt === 'not_applicable' ? 'Not applicable' : opt === 'override' ? 'Override' : opt === 'yes' ? 'Yes' : 'No'}
            </label>
          ))}
        </div>
        {answers[i.key] === 'override' ? (
          <input className="input mt-2 w-full text-sm" placeholder="Reason (required for override)" value={reasons[i.key] ?? ''} onChange={(e) => setReasons((p) => ({ ...p, [i.key]: e.target.value }))} />
        ) : null}
      </>
    );
  }

  const roteItems = items.filter((i) => !i.primary);
  const primaryItem = items.find((i) => i.primary);

  return (
    <div role="dialog" aria-modal="true">
      <div className="fixed inset-0 z-40 bg-slate-900/50" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-6 shadow-2xl" style={{ maxHeight: '85vh' }}>
        <h2 className="text-base font-semibold text-slate-900">Before we draft</h2>
        <p className="mt-1 text-sm text-slate-500">You verify each item — confirm what you see in the records, then make the nexus call.</p>
        <div className="mt-4 space-y-4">
          {roteItems.map((i) => (
            <div key={i.key} className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm text-slate-800">{i.label}</p>
              {radios(i)}
            </div>
          ))}
        </div>
        {primaryItem !== undefined ? (
          <div className="mt-4 rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Clinical judgment</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{primaryItem.label}</p>
            {radios(primaryItem)}
          </div>
        ) : null}
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
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">A &quot;No&quot; stops the draft. Retrieve those records, discuss with the veteran, or reconsider the nexus, then come back.</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!allResolved || anyNo || submitting} loading={submitting} onClick={() => void confirm()}>Start draft</Button>
        </div>
      </div>
    </div>
  );
}
