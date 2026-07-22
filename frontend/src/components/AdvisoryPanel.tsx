import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { askAdvisory, getAdvisoryThread, pollForCompletedAnswer, submitAdvisory, pollAdvisoryQuery, type AdvisoryThreadItem } from '../api/advisory';
import { describeAdvisoryError, describeApiError, isAdvisoryAnswerLikelyCompleting } from '../api/client';
import { Button } from './ui/Button';
import { Card } from './ui/Card';

// Async submit→poll ask (Ryan 2026-07-21): submit returns a queryId immediately, then we poll until the
// answer lands — so a slow (20-40s) Opus answer never hits the API-Gateway 30s cap and 504s. Flag-gated so
// rollback is one env flip; when off, the sync askAdvisory + task-#189 poll-fallback below is unchanged.
const ASYNC_ASK = import.meta.env.VITE_ADVISORY_ASYNC === 'on';

// "Ask Aegis" — read-only advisory Q&A about this case, grounded in FRN's reference library + Board data.
// Decision support ONLY: the model gets no tools, can't change anything, the human is the overseer.
// Collapsed by default (just the cue) so it never clutters the sign-off screen; the Q&A thread is saved
// and re-renders when the case is reopened.

function ThreadEntry({ item }: { readonly item: AdvisoryThreadItem }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="text-sm font-medium text-slate-800">Q: {item.question}</div>
      <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{item.answer}</div>
      {item.citations && item.citations.length > 0 ? (
        <div className="mt-2 text-xs text-slate-500">
          Sources:{' '}
          {item.citations.map((c, i) => (
            <span key={`${c.citation}-${i}`}>
              {i > 0 ? '; ' : ''}
              {c.citation}
              {c.letter_citable ? '' : ' (internal)'}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// `alwaysOpen` (Ryan 2026-06-13): on the dedicated "Ask Aegis" tab the Q&A opens immediately with no
// collapse + no card chrome (the tab IS the label). The physician sign-off page leaves it default
// (collapsible card) so it doesn't clutter the sign-off screen.
export function AdvisoryPanel({ caseId, alwaysOpen = false }: { readonly caseId: string; readonly alwaysOpen?: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  // "Still working" = the synchronous ask 5xx'd at the API-Gateway 30s cap and we're now polling the
  // queries endpoint for the answer the Lambda is finishing server-side (task #189). Keeps the wait
  // honest without ever showing the user a failure that didn't really happen.
  const [stillWorking, setStillWorking] = useState(false);
  const expanded = alwaysOpen || open;

  const thread = useQuery({
    queryKey: ['case', caseId, 'advisory-thread'],
    queryFn: () => getAdvisoryThread(caseId),
    enabled: expanded && caseId.length > 0,
  });

  const items = thread.data?.data ?? [];

  const ask = useMutation({
    mutationFn: async () => {
      const askedQuestion = question.trim();
      const askedAt = Date.now();
      // The rows already on screen BEFORE this ask — used to identify the NEW answer if we have to poll.
      const knownIds = new Set(items.map((it) => it.id));

      // ASYNC path: submit returns a queryId instantly (no 30s wall), then poll that id until terminal.
      // A landed answer (any status that carries text) renders via the thread on onSuccess; a terminal
      // error/refused (no answer) or a poll timeout throws → onError shows the calm message.
      if (ASYNC_ASK) {
        setStillWorking(true);
        const sub = await submitAdvisory(caseId, askedQuestion);
        const done = await pollAdvisoryQuery(caseId, sub.data.queryId);
        if (done && done.answer !== null && done.answer.length > 0) return;
        throw new Error(done ? 'advisory_terminal_no_answer' : 'advisory_poll_timeout');
      }

      try {
        await askAdvisory(caseId, askedQuestion);
        return; // happy path (sub-30s): onSuccess invalidates the thread, which renders the answer.
      } catch (err) {
        // A real 4xx refusal (400/404/413/422/429/403/409): nothing is completing — surface it now.
        if (!isAdvisoryAnswerLikelyCompleting(err)) throw err;
        // Timeout/5xx: the Lambda likely ran to completion and persisted the answer past the gateway's
        // 30s cap. Poll the existing GET queries endpoint for it — the user never sees an error.
        console.debug('[Ask Aegis] ask 5xx/timeout — polling for the completed answer:', describeApiError(err));
        setStillWorking(true);
        const found = await pollForCompletedAnswer(caseId, askedQuestion, askedAt, knownIds);
        if (found) return; // answer landed — onSuccess invalidates the thread and it renders normally.
        throw err; // poll exhausted (~45s, no answer): re-throw so onError shows the calm message.
      }
    },
    onSuccess: async () => {
      setQuestion('');
      await qc.invalidateQueries({ queryKey: ['case', caseId, 'advisory-thread'] });
    },
    onError: (e: unknown) => {
      // Plain-language only for the user (no codes/jargon); keep the real reason in the console for devs.
      console.debug('[Ask Aegis] advisory request failed:', describeApiError(e), e);
      window.alert(describeAdvisoryError(e));
    },
    onSettled: () => {
      setStillWorking(false);
    },
  });

  function submit() {
    if (question.trim().length > 0 && !ask.isPending) ask.mutate();
  }

  // The Q&A body — shared by both modes.
  const body = (
    <div className="space-y-4">
      {items.length > 0 ? (
        <div className="space-y-3">
          {items.map((it) => (
            <ThreadEntry key={it.id} item={it} />
          ))}
        </div>
      ) : thread.isLoading ? (
        <div className="text-sm text-slate-400">Loading…</div>
      ) : (
        <div className="text-sm text-slate-400">No questions yet — ask the first one below.</div>
      )}

      {ask.isPending ? (
        <div className="text-sm text-slate-400">
          {stillWorking ? 'Still working on it — this one is taking a little longer…' : 'Aegis is thinking…'}
        </div>
      ) : null}

      <div>
        <textarea
          className="input h-24 w-full"
          placeholder="e.g. Is this OSA claim viable secondary to his service-connected PTSD?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          // Enter submits; Shift+Enter inserts a newline (Ryan 2026-06-13).
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-400">
            Generated by AI · use thoughtfully — verify before relying on any answer. Enter to send, Shift+Enter for a new line.
          </span>
          <Button type="button" variant="primary" loading={ask.isPending} disabled={question.trim().length === 0} onClick={submit}>
            Ask
          </Button>
        </div>
      </div>
    </div>
  );

  // Tab mode: open immediately, no card, no collapse.
  if (alwaysOpen) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-500">Decision-support Q&amp;A about this case — viability, framing, Board data. Read-only.</p>
        {body}
      </div>
    );
  }

  // Sign-off-page mode: collapsible card (avoids cluttering the sign-off screen).
  return (
    <Card className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-lg p-5 text-left hover:bg-slate-50"
      >
        <div>
          <h2 className="text-base font-semibold text-slate-900">Ask Aegis</h2>
          <p className="text-sm text-slate-500">Decision-support Q&amp;A about this case — viability, framing, Board data.</p>
        </div>
        <span className="text-xs text-slate-400">{open ? 'Hide ▲' : 'Open ▼'}</span>
      </button>
      {open ? <div className="border-t border-slate-100 p-5">{body}</div> : null}
    </Card>
  );
}
