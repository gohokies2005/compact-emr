import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { getDelivery, sendDelivery, type DeliveryPreview } from '../api/delivery';

interface DeliveryPanelProps {
  readonly caseId: string;
  /** Opens the finalized letter PDF (reuse CaseDetailPage's openLetterPdf). */
  readonly onVerifyLetter: () => void | Promise<void>;
  /** Whether a viewable letter PDF exists (disables the verify-letter link when false). */
  readonly hasLetterPdf: boolean;
}

// RN delivery panel — shown once the physician approves (status delivered/paid). The RN verifies
// the letter + memo, ticks the confirm boxes, optionally edits the email, then sends from info@.
// Both external sends (Stripe + email) are stubbed: the panel still lets the RN compose/save and
// shows an amber "needs setup" note when a secret is missing. Mirrors PhysicianLetterReadyPanel
// styling.
export function DeliveryPanel({ caseId, onVerifyLetter, hasLetterPdf }: DeliveryPanelProps) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['case', caseId, 'delivery'], queryFn: () => getDelivery(caseId) });

  const [letterConfirmed, setLetterConfirmed] = useState(false);
  const [memoConfirmed, setMemoConfirmed] = useState(false);
  const [emailBody, setEmailBody] = useState('');
  const [showMemo, setShowMemo] = useState(false);
  const [sentMessage, setSentMessage] = useState<string | null>(null);

  const data: DeliveryPreview | undefined = q.data?.data;

  // Prefill the editable email from the composed preview (or a previously-saved draft) once loaded.
  useEffect(() => {
    if (data) setEmailBody(data.savedEmail?.body ?? data.email.body);
  }, [data]);

  const send = useMutation({
    mutationFn: () => sendDelivery(caseId, { emailBody }),
    onSuccess: async (res) => {
      setSentMessage(res.data.message);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['case', caseId, 'delivery'] }),
        qc.invalidateQueries({ queryKey: ['case', caseId] }),
      ]);
    },
  });

  if (q.isLoading) return <Card><p className="text-sm text-slate-500">Loading delivery…</p></Card>;
  if (!data) return <Card><p className="text-sm text-slate-500">Delivery is not available for this case.</p></Card>;

  const memoApplies = data.memo.applies;
  const stripeConfigured = data.stripe.configured;
  const emailTransportConfigured = data.emailTransport.configured;
  const alreadySent = data.savedEmail !== null;
  // Send is allowed once both applicable confirms are checked. The memo confirm only gates when a
  // memo applies. Stripe/email NOT being configured does NOT block compose+save (stub-friendly).
  const confirmsMet = letterConfirmed && (!memoApplies || memoConfirmed);

  return (
    <Card className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-slate-900">Deliver the letter</h2>
        <p className="text-sm text-slate-600">
          Verify the final letter{memoApplies ? ' and the cover memo' : ''}, confirm, then send the
          invoice email from info@flatratenexus.com.
        </p>
      </div>

      {/* Verify links */}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={!hasLetterPdf} title={hasLetterPdf ? undefined : 'No finalized PDF found'} onClick={() => void onVerifyLetter()}>
          Verify the final letter
        </Button>
        {memoApplies ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setShowMemo((s) => !s)}>
            {showMemo ? 'Hide cover memo' : 'Verify the cover memo'}
          </Button>
        ) : null}
      </div>

      {memoApplies && showMemo ? (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800">
          {data.memo.text ?? 'Cover memo text is unavailable.'}
        </pre>
      ) : null}

      {/* Confirm checkboxes */}
      <div className="mt-5 space-y-2">
        <label className="flex items-start gap-2 text-sm text-slate-800">
          <input type="checkbox" className="mt-0.5" checked={letterConfirmed} onChange={(e) => setLetterConfirmed(e.target.checked)} />
          <span>I verified the final letter is correct.</span>
        </label>
        {memoApplies ? (
          <label className="flex items-start gap-2 text-sm text-slate-800">
            <input type="checkbox" className="mt-0.5" checked={memoConfirmed} onChange={(e) => setMemoConfirmed(e.target.checked)} />
            <span>I verified the cover memo is correct.</span>
          </label>
        ) : null}
      </div>

      {/* Stripe link field */}
      <div className="mt-5">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">Stripe payment link</label>
        <input
          className="input mt-1 w-full font-mono text-xs"
          readOnly={stripeConfigured}
          defaultValue={data.stripe.link ?? ''}
          placeholder={stripeConfigured ? '' : 'Paste the $500 Stripe link here until Stripe is configured'}
        />
        {!stripeConfigured ? (
          <p className="mt-1 text-xs text-amber-700">
            Stripe is not configured. Add the STRIPE_LINK_500 key and the link will be generated automatically. You can paste a link above and into the email for now.
          </p>
        ) : null}
      </div>

      {/* Editable email preview */}
      <div className="mt-5">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
          Email preview (from {data.email.fromAddress}) — editable
        </label>
        <textarea
          className="input mt-1 min-h-64 w-full font-mono text-xs"
          value={emailBody}
          onChange={(e) => setEmailBody(e.target.value)}
        />
      </div>

      {!emailTransportConfigured ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Email sending is not configured. This will compose and save the email (ready to send). Add an email transport and it will send from info@.
        </div>
      ) : null}

      {alreadySent ? (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          A delivery email and a $500 invoice are already recorded for this case. Sending again is safe (it will not duplicate).
        </div>
      ) : null}

      {sentMessage ? <p className="mt-3 text-sm text-emerald-700">{sentMessage}</p> : null}
      {send.isError ? <p className="mt-3 text-sm text-rose-600">Could not record the delivery. Please retry.</p> : null}

      <div className="mt-5 flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
        {!confirmsMet ? (
          <span className="text-xs text-slate-500">Check the confirmation{memoApplies ? 's' : ''} to enable sending.</span>
        ) : null}
        <Button
          type="button"
          variant="primary"
          disabled={!confirmsMet}
          loading={send.isPending}
          onClick={() => send.mutate()}
        >
          {emailTransportConfigured ? 'Send from info@' : 'Compose + save (send when configured)'}
        </Button>
      </div>
    </Card>
  );
}
