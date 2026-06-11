import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InFlightDrafterPanel, type InFlightDraftJob } from '../components/InFlightDrafterPanel';
import type { DraftJobPhase } from '../types/prisma';

// Fixtures use the drafter's REAL phase ids (DraftJobPhase — the snake_case manifest ids it posts
// as currentPhase), not human labels. Fixture matches the actual DraftJob shape (no `failedAt`;
// optional-not-nullable completedAt/errorMessage omitted; updatedAt required).
const baseJob: InFlightDraftJob = {
  id: 'draft-job-1',
  caseId: 'CASE-1',
  state: 'running',
  version: 1,
  enqueuedAt: '2026-05-25T12:00:00.000Z',
  startedAt: '2026-05-25T12:01:00.000Z',
  updatedAt: '2026-05-25T12:01:00.000Z',
  currentPhase: 'adversary_panel',
  nextRetryInS: null,
};

describe('InFlightDrafterPanel', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('renders Step 4 of 6 + elapsed time for the review-panel phase', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:05:12.000Z'));

    render(<InFlightDrafterPanel job={baseJob} />);

    expect(screen.getByText('Drafting the letter')).toBeInTheDocument();
    expect(screen.getByText('Step 4 of 6 — Reviewing the draft')).toBeInTheDocument();
    expect(screen.getByText('Step 4/6')).toBeInTheDocument();
    expect(screen.getByText('running 4m 12s')).toBeInTheDocument();
    expect(screen.getByText('This usually takes 10–20 minutes.')).toBeInTheDocument();
  });

  it('the elapsed timer ticks up LIVE (not frozen between polls)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:01:00.000Z')); // == startedAt → 0s
    render(<InFlightDrafterPanel job={baseJob} />);
    expect(screen.getByText('running 0s')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText('running 5s')).toBeInTheDocument();
  });

  it('maps the drafter phase to Step 3 of 6 (Writing)', () => {
    render(<InFlightDrafterPanel job={{ ...baseJob, currentPhase: 'drafter' }} />);
    expect(screen.getByText('Step 3 of 6 — Writing the draft')).toBeInTheDocument();
  });

  it('maps the framing gate to Step 2 of 6 (Checking)', () => {
    render(<InFlightDrafterPanel job={{ ...baseJob, currentPhase: 'framing_gate' }} />);
    expect(screen.getByText('Step 2 of 6 — Checking the claim')).toBeInTheDocument();
  });

  it('maps citation_scoring to Step 5 (Revising) — never backward to Writing', () => {
    render(<InFlightDrafterPanel job={{ ...baseJob, currentPhase: 'citation_scoring' }} />);
    expect(screen.getByText('Step 5 of 6 — Revising')).toBeInTheDocument();
  });

  it('falls back to Step 1 of 6 when the phase is unset', () => {
    render(<InFlightDrafterPanel job={{ ...baseJob, currentPhase: null }} />);
    expect(screen.getByText('Step 1 of 6 — Reading the records')).toBeInTheDocument();
  });

  it('the step never moves BACKWARD across the real pipeline order', () => {
    // The order the drafter advances through its phases. The bucketed step must be monotonically
    // non-decreasing — this is the regression guard against the human-label-substring bug.
    // The REAL execution order from run-letter-pipeline.js (currentPhase assignments), incl.
    // cover_memo (supplemental/appeal pathway) which runs after framing_gate, before source_lock.
    const order: DraftJobPhase[] = [
      'preflight', 'index_consult', 'framing_gate', 'cover_memo', 'source_lock', 'drafter',
      'adversary_panel', 'specialist_gate', 'refine_loop', 'surgical_edit',
      'citation_scoring', 'pmid_verify', 'linter', 'qa_report', 'grader', 'render',
    ];
    let prev = 0;
    for (const phase of order) {
      const { unmount } = render(<InFlightDrafterPanel job={{ ...baseJob, currentPhase: phase }} />);
      const m = screen.getByText(/Step (\d) of 6/).textContent!.match(/Step (\d) of 6/)!;
      const stepNum = Number(m[1]);
      expect(stepNum, `phase ${phase} should not regress below ${prev}`).toBeGreaterThanOrEqual(prev);
      prev = stepNum;
      unmount();
    }
    expect(prev).toBe(6); // render = final step
  });

  it('shows the longer-than-usual message for retrying jobs', () => {
    render(<InFlightDrafterPanel job={{ ...baseJob, nextRetryInS: 60 }} />);
    expect(screen.getByText('Still working — taking a little longer than usual.')).toBeInTheDocument();
  });

  it('shows operatorMessage verbatim when present', () => {
    render(<InFlightDrafterPanel job={{ ...baseJob, operatorMessage: "We've paused this one for a closer look." }} />);
    expect(screen.getByText("We've paused this one for a closer look.")).toBeInTheDocument();
  });
});

// QUEUED mode — the cross-case queue-position indicator. The case is already status='drafting' the
// instant a job enqueues; this panel keeps the user honestly informed until the job flips to running.
// A queued job has no startedAt yet — omit it (the type is optional, not nullable).
const { startedAt: _omitStartedAt, ...baseJobNoStart } = baseJob;
const queuedJob: InFlightDraftJob = { ...baseJobNoStart, state: 'queued', currentPhase: null };

describe('InFlightDrafterPanel — QUEUED mode', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('shows the precise "#N in line" copy ONLY when running === max && queuedAhead >= 1', () => {
    render(<InFlightDrafterPanel job={queuedJob} concurrency={{ running: 6, max: 6, queuedAhead: 2, queuePosition: 3 }} />);
    expect(screen.getByText('Your letter is in line to start.')).toBeInTheDocument();
    // The position is rendered inline; assert the #3 appears in the line copy.
    expect(screen.getByText(/#3/)).toBeInTheDocument();
    expect(screen.getByText(/busy with other letters/)).toBeInTheDocument();
    // It must NOT show the progress bar / "Step X of 6" while queued.
    expect(screen.queryByText(/Step \d of 6/)).not.toBeInTheDocument();
  });

  it('shows the generic "getting ready" copy when running < max (cold start warming up)', () => {
    render(<InFlightDrafterPanel job={queuedJob} concurrency={{ running: 2, max: 6, queuedAhead: 0, queuePosition: 1 }} />);
    expect(screen.getByText('Starting the drafting engine.')).toBeInTheDocument();
    expect(screen.queryByText('Your letter is in line to start.')).not.toBeInTheDocument();
    expect(screen.queryByText(/#1/)).not.toBeInTheDocument();
  });

  it('shows the generic copy when at max but nothing is actually ahead (queuedAhead === 0)', () => {
    render(<InFlightDrafterPanel job={queuedJob} concurrency={{ running: 6, max: 6, queuedAhead: 0, queuePosition: 1 }} />);
    expect(screen.getByText('Starting the drafting engine.')).toBeInTheDocument();
  });

  it('shows the generic copy when concurrency is null/unknown', () => {
    render(<InFlightDrafterPanel job={queuedJob} concurrency={null} />);
    expect(screen.getByText('Starting the drafting engine.')).toBeInTheDocument();
  });

  it('falls back to the generic copy once a frozen "#N" sits unchanged past ~2 min', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    const concurrency = { running: 6, max: 6, queuedAhead: 2, queuePosition: 3 } as const;
    const { rerender } = render(<InFlightDrafterPanel job={queuedJob} concurrency={concurrency} />);
    // Fresh: precise position shows.
    expect(screen.getByText('Your letter is in line to start.')).toBeInTheDocument();

    // Position never advances for >2 min — the 1s tick + an unchanged-position rerender flips it to
    // the calm generic copy (a stuck "#N" reads as more broken than silence).
    act(() => { vi.advanceTimersByTime(2 * 60 * 1000 + 1000); });
    rerender(<InFlightDrafterPanel job={queuedJob} concurrency={concurrency} />);
    expect(screen.getByText('Starting the drafting engine.')).toBeInTheDocument();
    expect(screen.queryByText('Your letter is in line to start.')).not.toBeInTheDocument();
  });

  it('switches to the progress bar automatically when the job flips to running', () => {
    const { rerender } = render(<InFlightDrafterPanel job={queuedJob} concurrency={{ running: 6, max: 6, queuedAhead: 2, queuePosition: 3 }} />);
    expect(screen.getByText('Your letter is in line to start.')).toBeInTheDocument();

    rerender(<InFlightDrafterPanel job={{ ...queuedJob, state: 'running', currentPhase: 'drafter' }} concurrency={null} />);
    expect(screen.getByText('Drafting the letter')).toBeInTheDocument();
    expect(screen.getByText('Step 3 of 6 — Writing the draft')).toBeInTheDocument();
    expect(screen.queryByText('Your letter is in line to start.')).not.toBeInTheDocument();
  });
});
