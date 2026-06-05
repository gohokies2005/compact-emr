import { useMutation } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { postDraft, type RnDecisionInput } from '../api/drafter';
import { transitionCaseStatus, type CaseDetail } from '../api/cases';
import { describeApiError } from '../api/client';
import type { DraftJob, Gate2HaltPayload } from '../types/prisma';

/**
 * Gate-2 halt screen — shown when the pre-draft dx/event verification PARKED the case
 * (status needs_rn_decision / needs_records). Renders the plain-English reason + any switch
 * proposal and gives the RN actionable buttons (NEVER a dead-end): override + draft as-is,
 * switch to the better-fit dx, "records are in — re-run", or pause to gather records. Each is
 * logged + shown in the Decisions panel.
 */
export function Gate2HaltPanel({ c, job, onChanged }: { readonly c: CaseDetail; readonly job?: DraftJob; readonly onChanged: () => void | Promise<void> }) {
  const payload: Gate2HaltPayload = (job?.haltPayloadJson as Gate2HaltPayload | null | undefined) ?? {};
  const message = payload.plainEnglish || payload.operatorMessage || c.operatorMessage || 'The pre-draft verification could not confirm the diagnosis and/or in-service event. Decide how to proceed.';
  const sw = payload.switchProposal ?? null;

  const resume = useMutation({
    mutationFn: (rnDecision: RnDecisionInput) => postDraft(c.id, { rnDecision }),
    onSuccess: () => void onChanged(),
    onError: (e: unknown) => window.alert(`Could not resume drafting — ${describeApiError(e)}`),
  });
  const pause = useMutation({
    mutationFn: () => transitionCaseStatus(c.id, { from: c.status, to: 'needs_records', version: c.version }),
    onSuccess: () => void onChanged(),
    onError: (e: unknown) => window.alert(`Could not pause — ${describeApiError(e)}`),
  });

  function override() {
    const reason = window.prompt('Draft anyway on the claimed condition? Type a brief reason — it is logged and shown in the chart.');
    if (reason === null || reason.trim().length === 0) return;
    resume.mutate({ gate2Override: true, reason: reason.trim() });
  }
  function doSwitch() {
    if (sw === null) return;
    const reason = window.prompt(`Switch the letter to ${sw.dx} and re-draft? Type a brief reason (logged).`) ?? '';
    resume.mutate({ switchToCondition: sw.dx, reason: reason.trim().length > 0 ? reason.trim() : `switch to ${sw.dx}` });
  }
  function proceed() {
    if (!window.confirm('The diagnosis / records are now present — re-run the draft?')) return;
    resume.mutate({ proceed: true });
  }

  const busy = resume.isPending || pause.isPending;
  return (
    <Card className="rounded-lg border border-amber-300 bg-amber-50 p-6">
      <h2 className="text-base font-semibold text-amber-900">Drafting paused — your decision needed</h2>
      <p className="mt-2 text-sm text-amber-900">{message}</p>
      {sw !== null ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-white p-3 text-sm text-slate-700">
          <span className="font-semibold">Possible stronger fit: </span>
          {sw.plainEnglish || `The records show ${sw.dx}${sw.scAnchor ? ` (anchor: ${sw.scAnchor})` : ''}.${sw.whyMoreViable ? ` ${sw.whyMoreViable}` : ''}`}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {sw !== null ? <Button variant="primary" size="sm" disabled={busy} onClick={doSwitch}>Switch to {sw.dx}</Button> : null}
        <Button variant="secondary" size="sm" disabled={busy} onClick={override}>Draft anyway (override)</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={proceed}>Records are in — re-run</Button>
        {c.status !== 'needs_records' ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => pause.mutate()}>Pause to get records</Button> : null}
      </div>
      <p className="mt-3 text-xs text-amber-800">Every choice is logged and shown in the chart&apos;s Decisions &amp; overrides panel.</p>
    </Card>
  );
}
