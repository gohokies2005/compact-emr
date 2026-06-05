import { useMemo, useState } from 'react';
import { Button } from './ui/Button';
import { postGate1Attestations } from '../api/drafter';
import { describeApiError } from '../api/client';

type Answer = 'yes' | 'no' | 'override' | 'not_applicable';
interface Item { readonly key: string; readonly label: string; readonly allowNA?: boolean }

/**
 * Gate-1 "Before we draft" checklist (human attestation; no AI). Fires when the RN starts a draft.
 * Every shown item must be Yes, Override+reason, or (SC-conditions) Not applicable. A "No" blocks
 * with a one-line next step. Attestations are written to the chart (draft_decisions, gate=1) BEFORE
 * the draft is enqueued. Gate-2 (the AI dx/event check) is the backstop for a lazy attestation.
 */
export function Gate1ChecklistModal({ caseId, claimType, claimedCondition, draftAttempt, onConfirmed, onClose }: {
  readonly caseId: string;
  readonly claimType: string;
  readonly claimedCondition: string;
  readonly draftAttempt: number;
  readonly onConfirmed: () => void;
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
      onConfirmed();
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
        <div className="mt-4 space-y-4">
          {items.map((i) => (
            <div key={i.key} className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm text-slate-800">{i.label}</p>
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
