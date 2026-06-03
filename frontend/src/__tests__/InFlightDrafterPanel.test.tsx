import { render, screen } from '@testing-library/react';
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
