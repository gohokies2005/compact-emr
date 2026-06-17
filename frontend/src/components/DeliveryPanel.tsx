import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { describeApiError } from '../api/client';
import { getDelivery, openMemoPdf, resetDeliveryLock, sendDelivery, type DeliveryPreview } from '../api/delivery';

interface DeliveryPanelProps {
  readonly caseId: string;
  /** Opens the finalized letter PDF (reuse CaseDetailPage's openLetterPdf). */
  readonly onVerifyLetter: () => void | Promise<void>;
  /** Whether a viewable letter PDF exists (disables the verify-letter link when false). */
  readonly hasLetterPdf: boolean;
}

// RN delivery panel — shown once the physician approves (status delivered/paid). The RN verifies
// the letter + memo (both as PDFs), ticks the confirm boxes, optionally edits the email, then
// sends the invoice email from info@ via SES (Chunk E3 — a real transmit; until SES production
// access it lands in the staff inbox as [FWD to vet] via the sandbox forwarding mode). Stripe
// remains config-gated. Mirrors PhysicianLetterReadyPanel styling.
export function DeliveryPanel({ caseId, onVerifyLetter, hasLetterPdf }: DeliveryPanelProps) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['case', caseId, 'delivery'], queryFn: () => getDelivery(caseId) });

  const [letterConfirmed, setLetterConfirmed] = useState(false);
  const [memoConfirmed, setMemoConfirmed] = useState(false);
  const [emailBody, setEmailBody] = useState('');
  const [memoError, setMemoError] = useState<string | null>(null);
  const [memoOpening, setMemoOpening] = useState(false);
  // The send outcome: ok=true → green; ok=false → the route returned 200 but the transport
  // failed (the message carries the REAL error verbatim) → red.
  const [sentMessage, setSentMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  // E4: "Verify the cover memo" opens a true PDF in a new tab (like the letter verify), rendered
  // server-side by GET /delivery/memo.pdf. Failures surface the REAL reason (standing rule).
  async function verifyMemoPdf() {
    setMemoError(null);
    setMemoOpening(true);
    try {
      await openMemoPdf(caseId);
    } catch (e) {
      setMemoError(`Could not open the cover memo PDF: ${describeApiError(e)}`);
    } finally {
      setMemoOpening(false);
    }
  }

  const data: DeliveryPreview | undefined = q.data?.data;

  // Prefill the editable email from the composed preview (or a previously-saved draft) once loaded.
  useEffect(() => {
    if (data) setEmailBody(data.savedEmail?.body ?? data.email.body);
  }, [data]);

  // Resend cooldown (Ryan 2026-06-12): once the email has been sent, the Send button is replaced
  // with "Resend to veteran", disabled for 30s after the last send click so a worried staffer
  // can't machine-gun the veteran's inbox.
  const COOLDOWN_MS = 30_000;
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (lastSentAt === null) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lastSentAt]);

  const send = useMutation({
    mutationFn: (opts: { resend?: boolean }) =>
      sendDelivery(caseId, { emailBody, ...(opts.resend === true ? { resend: true } : {}) }),
    onSuccess: async (res) => {
      setSentMessage({ text: res.data.message, ok: res.data.emailSent });
      if (res.data.emailSent) setLastSentAt(Date.now());
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['case', caseId, 'delivery'] }),
        qc.invalidateQueries({ queryKey: ['case', caseId] }),
      ]);
    },
  });

  const resetLock = useMutation({
    mutationFn: () => resetDeliveryLock(caseId),
    onSuccess: async (res) => {
      setResetMessage(
        res.data.tokensReset > 0
          ? `Delivery lock cleared (${res.data.tokensReset} link${res.data.tokensReset === 1 ? '' : 's'} reset). The veteran can use the same link again.`
          : 'No locked delivery link found for this case.',
      );
      await qc.invalidateQueries({ queryKey: ['case', caseId, 'delivery'] });
    },
  });

  if (q.isLoading) return <Card><p className="text-sm text-slate-500">Loading delivery…</p></Card>;
  if (!data) return <Card><p className="text-sm text-slate-500">Delivery is not available for this case.</p></Card>;

  const memoApplies = data.memo.applies;
  const stripeConfigured = data.stripe.configured;
  const emailTransportConfigured = data.emailTransport.configured;
  // An existing delivery row is COMPOSED/QUEUED, not transmitted, until a real transport sets a
  // sentAt. Never say "sent" unless the row actually reports it.
  const alreadyComposed = data.savedEmail !== null;
  const actuallySent = data.savedEmail?.status === 'sent' && data.savedEmail?.sentAt != null;
  // Send is allowed once both applicable confirms are checked. The memo confirm only gates when a
  // memo applies. Stripe/email NOT being configured does NOT block compose+save (stub-friendly).
  const confirmsMet = letterConfirmed && (!memoApplies || memoConfirmed);
  // Once sent (this session or a prior one), the Send button becomes Resend. Cooldown applies only
  // to a send done in THIS session (lastSentAt) — a reload of an already-sent case can resend
  // immediately, and the 30s lock kicks in after that click.
  const hasBeenSent = actuallySent || lastSentAt !== null;
  const cooldownRemainingMs = lastSentAt !== null ? Math.max(0, COOLDOWN_MS - (nowMs - lastSentAt)) : 0;
  const cooldownSecs = Math.ceil(cooldownRemainingMs / 1000);

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
          <Button type="button" variant="secondary" size="sm" loading={memoOpening} onClick={() => void verifyMemoPdf()}>
            Verify the cover memo
          </Button>
        ) : null}
      </div>

      {/* P0d (Ryan 2026-06-13): never let "no cover memo" be silent. When the case is classified as
          an original claim, say so + how to fix it — appeals/supplementals must carry a memo, and
          the only reason one wouldn't generate is the case not being flagged as one. */}
      {!memoApplies ? (
        <p className="mt-2 text-xs text-slate-500">
          No cover memo applies — this case is classified as an original claim (no prior denial on
          file). If it is an appeal, supplemental, HLR, or TDIU, set the claim type / prior-denial on
          the case and a memo will generate automatically.
        </p>
      ) : null}

      {memoError ? <p className="mt-2 text-sm text-rose-600">{memoError}</p> : null}

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
          Email sending is not configured (SES from-address missing). This will compose and save the email (ready to send). Add SES_FROM_ADDRESS and it will send from info@.
        </div>
      ) : null}

      {alreadyComposed ? (
        actuallySent ? (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            This delivery email has been sent and a $500 invoice is recorded for this case. If the veteran didn’t receive it, use <strong>Resend to veteran</strong> below — it re-sends the same secure link and does NOT create a second invoice.
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
            A delivery email is composed and a $500 invoice is recorded for this case — <strong>pending send</strong> (not yet transmitted). Sending will transmit it; retrying is safe (it will not duplicate).
          </div>
        )
      ) : null}

      {sentMessage ? (
        <p className={`mt-3 text-sm ${sentMessage.ok ? 'text-emerald-700' : 'text-rose-600'}`}>{sentMessage.text}</p>
      ) : null}
      {send.isError ? <p className="mt-3 text-sm text-rose-600">Send failed: {describeApiError(send.error)}</p> : null}

      <div className="mt-5 flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
        {hasBeenSent ? (
          // Sent already → Resend, with a 30s cooldown after the last send. No confirm gate: the
          // letter was verified on the first send and the byte-binding gate re-checks it server-side.
          <Button
            type="button"
            variant="secondary"
            disabled={cooldownRemainingMs > 0}
            loading={send.isPending}
            onClick={() => send.mutate({ resend: true })}
          >
            {cooldownRemainingMs > 0 ? `Resend to veteran (wait ${cooldownSecs}s)` : 'Resend to veteran'}
          </Button>
        ) : (
          <>
            {!confirmsMet ? (
              <span className="text-xs text-slate-500">Check the confirmation{memoApplies ? 's' : ''} to enable sending.</span>
            ) : null}
            <Button
              type="button"
              variant="primary"
              disabled={!confirmsMet}
              loading={send.isPending}
              onClick={() => send.mutate({})}
            >
              {emailTransportConfigured ? 'Send the invoice email' : 'Compose + save (pending send — transport not configured)'}
            </Button>
          </>
        )}
      </div>

      {/* Veteran can't open the secure download (5 failed identity attempts → "this link is now
          locked"). Staff (admin or RN/ops) verifies the veteran out-of-band, fixes phone/DOB on the
          chart if needed, then clears the lock — the SAME emailed link works again, no re-send.
          (Ryan 2026-06-17: no admin/RN UI existed for this.) */}
      <div className="mt-5 border-t border-slate-200 pt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Veteran can’t open the download?</p>
        <p className="mt-1 text-sm text-slate-600">
          If the secure link shows “this link is now locked,” verify the veteran, correct their phone or
          date of birth on the chart if needed, then reset the lock. The same link starts working again.
        </p>
        <div className="mt-2">
          <Button type="button" variant="secondary" size="sm" loading={resetLock.isPending} onClick={() => resetLock.mutate()}>
            Reset delivery lock
          </Button>
        </div>
        {resetMessage ? <p className="mt-2 text-sm text-emerald-700">{resetMessage}</p> : null}
        {resetLock.isError ? <p className="mt-2 text-sm text-rose-600">Could not reset: {describeApiError(resetLock.error)}</p> : null}
      </div>
    </Card>
  );
}
