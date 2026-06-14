import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { signOffCase, type ChartReadinessBlockingFile, type SignOffAnswers, type SignOffQuestionKey } from '../api/cases';
import { ConflictError } from '../api/client';
import { documentFileName } from '../lib/documentFileName';

// Plain-English rendering of the machine-read failure reason a blocking file carries (lastAttempt.note,
// e.g. "too-few-words (22 < 20)" / "empty (0 words)" / "garbled ..."). Falls back to a calm default so
// the physician always sees WHY a file is blocking — never a blank or a raw code.
function readableReason(file: ChartReadinessBlockingFile): string {
  const note = file.lastAttempt?.note ?? null;
  if (note === null || note.trim().length === 0) return 'could not be read automatically';
  if (note.startsWith('empty')) return 'no readable text (the scan came through blank)';
  if (note.startsWith('too-few-words')) return 'too little readable text to verify';
  if (note.startsWith('garbled')) return 'text came through garbled / unreadable';
  return note;
}

// Pull the structured blocking files out of a chart-readiness 409 (ConflictError), or null if this
// error is anything else. The override UI renders ONLY when this returns a non-empty list.
function chartNotReadyFiles(error: unknown): ChartReadinessBlockingFile[] | null {
  if (!(error instanceof ConflictError) || error.serverCode !== 'chart_not_ready') return null;
  const details = error.current as { blockingFiles?: unknown } | undefined;
  const files = details?.blockingFiles;
  return Array.isArray(files) ? (files as ChartReadinessBlockingFile[]) : null;
}

const SIGN_OFF_QUESTIONS: readonly { readonly key: SignOffQuestionKey; readonly label: string }[] = [
  { key: 'records_reviewed', label: 'I reviewed all uploaded records and the chart.' },
  { key: 'diagnosis_documented', label: 'The claimed diagnosis is documented in the records.' },
  { key: 'nexus_supported', label: 'Medical literature supports >50% probability.' },
  { key: 'no_phi_in_letter', label: 'The letter contains no PHI that should not be there.' },
  { key: 'final_pdf_correct', label: 'The final PDF preview is correct (name, condition, date).' },
];

type DraftAnswers = Partial<Record<SignOffQuestionKey, boolean>>;

interface SignOffPopupProps {
  readonly caseId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSignedOff?: () => void | Promise<void>;
  // Override the default sign-off submit (import deliver-as-is, 2026-06-14). When provided, the
  // affirmative answers are handed to this submitter INSTEAD of POST /sign-off — the imported-letter
  // finalize path records its OWN sign-off bound to the PDF bytes, so it cannot use the TXT-binding
  // POST /sign-off. The all-affirmative gate + UI are reused unchanged. onSignedOff still fires after.
  readonly onSubmitAnswers?: (input: { answers: SignOffAnswers; notes?: string; overrideChartReadiness?: boolean; chartReadinessOverrideReason?: string }) => Promise<unknown>;
  // Optional copy overrides so the popup reads as a finalize step rather than a plain sign-off.
  readonly title?: string;
  readonly submitLabel?: string;
}

function toCompleteAnswers(draft: DraftAnswers): SignOffAnswers | null {
  const missing = SIGN_OFF_QUESTIONS.some((q) => draft[q.key] === undefined);
  if (missing) return null;
  return {
    records_reviewed: draft.records_reviewed === true,
    diagnosis_documented: draft.diagnosis_documented === true,
    nexus_supported: draft.nexus_supported === true,
    no_phi_in_letter: draft.no_phi_in_letter === true,
    final_pdf_correct: draft.final_pdf_correct === true,
  };
}

export function SignOffPopup({ caseId, open, onClose, onSignedOff, onSubmitAnswers, title, submitLabel }: SignOffPopupProps) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [answers, setAnswers] = useState<DraftAnswers>({});
  const [notes, setNotes] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Chart-readiness override flow (CLM-4DACAF4A80, 2026-06-14): set when the sign-off submit hit a
  // chart_not_ready 409. We DON'T dead-end — instead we show the blocking files + an explicit override
  // control. overrideAck = the physician checked "I have personally reviewed these records"; the reason
  // is a required free-text legal basis. "Sign off anyway" re-submits with overrideChartReadiness:true.
  const [blockingFiles, setBlockingFiles] = useState<ChartReadinessBlockingFile[] | null>(null);
  const [overrideAck, setOverrideAck] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const overrideReady = useMemo(() => overrideAck && overrideReason.trim().length > 0, [overrideAck, overrideReason]);

  const completeAnswers = useMemo(() => toCompleteAnswers(answers), [answers]);
  // Every question is a POSITIVE attestation — a "No" on any means the letter is NOT ready to finalize,
  // so Submit requires all-affirmative (a physician with a concern sends back, not signs off against it).
  const allAffirmative = useMemo(() => completeAnswers !== null && Object.values(completeAnswers).every((v) => v === true), [completeAnswers]);
  const hasNegative = useMemo(() => Object.values(answers).some((v) => v === false), [answers]);

  const signOffMutation = useMutation({
    // `override` is passed by the "Sign off anyway" button; the normal Submit calls with no arg, so the
    // gate-passes payload is byte-identical (no override fields appear).
    mutationFn: (override?: { reason: string }) => {
      if (!allAffirmative || completeAnswers === null) throw new Error('Every item must be "Yes" to sign off. Resolve a "No", or use "Send back to RN" instead.');
      const input = {
        answers: completeAnswers,
        ...(notes.trim().length > 0 && { notes: notes.trim() }),
        ...(override ? { overrideChartReadiness: true, chartReadinessOverrideReason: override.reason } : {}),
      };
      // Imported-letter finalize hands the same affirmative answers to its own PDF-binding submitter.
      return onSubmitAnswers ? onSubmitAnswers(input) : signOffCase(caseId, input);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['case', caseId] }),
        queryClient.invalidateQueries({ queryKey: ['case', caseId, 'sign-offs'] }),
      ]);
      await onSignedOff?.();
      setAnswers({});
      setNotes('');
      setErrorMessage(null);
      setBlockingFiles(null);
      setOverrideAck(false);
      setOverrideReason('');
      onClose();
    },
    onError: (error: unknown) => {
      // A chart-readiness 409 is NOT a dead-end: surface the blocking files + the override control
      // instead of a flat error. Any other error keeps the existing plain-message behavior.
      const files = chartNotReadyFiles(error);
      if (files !== null && files.length > 0) {
        setBlockingFiles(files);
        setErrorMessage(null);
        return;
      }
      const message = error instanceof Error ? error.message : 'Sign-off could not be saved. Please retry.';
      setErrorMessage(message);
    },
  });

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', handleKeyDown);
    window.setTimeout(() => dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus(), 0);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) {
      setErrorMessage(null);
      setBlockingFiles(null);
      setOverrideAck(false);
      setOverrideReason('');
    }
  }, [open]);

  if (!open) return null;

  function setAnswer(key: SignOffQuestionKey, value: boolean) {
    setAnswers((current) => ({ ...current, [key]: value }));
    setErrorMessage(null);
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="sign-off-title">
      <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" />
      <div ref={dialogRef} className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="sign-off-title" className="text-lg font-semibold text-slate-900">{title ?? 'Physician sign-off'}</h2>
            <p className="mt-1 text-sm text-slate-500">Confirm each item before the letter is finalized.</p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>

        <div className="mt-4 space-y-3">
          {SIGN_OFF_QUESTIONS.map((q) => {
            const selected = answers[q.key];
            return (
              <div key={q.key} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-medium text-slate-800">{q.label}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    <button type="button" onClick={() => setAnswer(q.key, true)} className={`inline-flex rounded-full border px-3 py-1 text-sm ${selected === true ? 'border-emerald-300 bg-emerald-100 text-emerald-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>Yes</button>
                    <button type="button" onClick={() => setAnswer(q.key, false)} className={`inline-flex rounded-full border px-3 py-1 text-sm ${selected === false ? 'border-rose-300 bg-rose-100 text-rose-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>No</button>
                  </div>
                </div>
              </div>
            );
          })}

          <label className="block">
            <span className="text-sm font-medium text-slate-800">Notes (optional)</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} maxLength={500} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200" placeholder="Optional physician sign-off note." />
            <span className="mt-1 block text-xs text-slate-500">{notes.length}/500</span>
          </label>

          {hasNegative ? (
            <div className="rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
              A “No” means the letter isn’t ready to finalize. Resolve the issue, or use <span className="font-medium">Send back to RN</span> instead of signing off.
            </div>
          ) : null}

          {errorMessage ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{errorMessage}</div> : null}

          {blockingFiles !== null ? (
            <div className="rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-4 text-sm text-amber-900" data-testid="chart-readiness-override">
              <p className="font-semibold">Some uploaded records could not be read automatically.</p>
              <p className="mt-1">
                {blockingFiles.length === 1 ? 'This file has' : `These ${blockingFiles.length} files have`} no machine-readable text and no manual summary yet. You can have a colleague add a manual summary, or — if you have personally reviewed {blockingFiles.length === 1 ? 'this record' : 'these records'} — sign off with the override below.
              </p>
              <ul className="mt-2 space-y-1">
                {blockingFiles.map((f) => (
                  <li key={f.fileReadStatusId} className="flex flex-col">
                    <span className="font-medium text-amber-950">{documentFileName(f.filePath)}</span>
                    <span className="text-xs text-amber-800">{readableReason(f)}</span>
                  </li>
                ))}
              </ul>

              <label className="mt-3 flex items-start gap-2">
                <input type="checkbox" checked={overrideAck} onChange={(e) => setOverrideAck(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-amber-400 text-amber-700 focus:ring-amber-400" />
                <span className="text-sm font-medium text-amber-950">I have personally reviewed these records that couldn’t be auto-read.</span>
              </label>

              <label className="mt-3 block">
                <span className="text-sm font-medium text-amber-950">Reason for the override (required)</span>
                <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={3} maxLength={500} className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200" placeholder="e.g. I reviewed each of these scans in person; they are legible to me and support the opinion." />
              </label>
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={signOffMutation.isPending}>Cancel</Button>
          {blockingFiles !== null ? (
            <Button type="button" variant="primary" loading={signOffMutation.isPending} disabled={!allAffirmative || !overrideReady || signOffMutation.isPending} onClick={() => signOffMutation.mutate({ reason: overrideReason.trim() })}>Sign off anyway</Button>
          ) : (
            <Button type="button" variant="primary" loading={signOffMutation.isPending} disabled={!allAffirmative || signOffMutation.isPending} onClick={() => signOffMutation.mutate(undefined)}>{submitLabel ?? 'Submit sign-off'}</Button>
          )}
        </div>
      </div>
    </div>
  );
}
