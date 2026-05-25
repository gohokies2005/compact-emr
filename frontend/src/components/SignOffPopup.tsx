import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { signOffCase, type SignOffAnswers, type SignOffQuestionKey } from '../api/cases';

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

export function SignOffPopup({ caseId, open, onClose, onSignedOff }: SignOffPopupProps) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [answers, setAnswers] = useState<DraftAnswers>({});
  const [notes, setNotes] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const completeAnswers = useMemo(() => toCompleteAnswers(answers), [answers]);

  const signOffMutation = useMutation({
    mutationFn: () => {
      if (!completeAnswers) throw new Error('All sign-off questions require an answer.');
      return signOffCase(caseId, {
        answers: completeAnswers,
        ...(notes.trim().length > 0 && { notes: notes.trim() }),
      });
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
      onClose();
    },
    onError: (error: unknown) => {
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

  useEffect(() => { if (!open) setErrorMessage(null); }, [open]);

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
            <h2 id="sign-off-title" className="text-lg font-semibold text-slate-900">Physician sign-off</h2>
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

          {errorMessage ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{errorMessage}</div> : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={signOffMutation.isPending}>Cancel</Button>
          <Button type="button" variant="primary" loading={signOffMutation.isPending} disabled={!completeAnswers || signOffMutation.isPending} onClick={() => signOffMutation.mutate()}>Submit sign-off</Button>
        </div>
      </div>
    </div>
  );
}
