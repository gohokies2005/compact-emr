import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InFlightDrafterPanel, type InFlightDraftJob } from '../components/InFlightDrafterPanel';

// Fixture matches our actual DraftJob shape (no `failedAt`; optional-not-nullable
// completedAt/errorMessage — omit instead of passing null; updatedAt required).
const baseJob: InFlightDraftJob = {
  id: 'draft-job-1',
  caseId: 'CASE-1',
  state: 'running',
  version: 1,
  enqueuedAt: '2026-05-25T12:00:00.000Z',
  startedAt: '2026-05-25T12:01:00.000Z',
  updatedAt: '2026-05-25T12:01:00.000Z',
  currentPhase: 'PHASE 4: REVIEW PANEL',
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

  it('maps drafting phases to Step 3 of 6', () => {
    render(<InFlightDrafterPanel job={{ ...baseJob, currentPhase: 'PHASE 2: CITATIONS' }} />);
    expect(screen.getByText('Step 3 of 6 — Writing the draft')).toBeInTheDocument();
  });

  it('maps the framing gate to Step 2 of 6', () => {
    render(<InFlightDrafterPanel job={{ ...baseJob, currentPhase: 'PHASE 0.4: FRAMING GATE' }} />);
    expect(screen.getByText('Step 2 of 6 — Checking the claim')).toBeInTheDocument();
  });

  it('falls back to Step 1 of 6 when the phase is unset', () => {
    render(<InFlightDrafterPanel job={{ ...baseJob, currentPhase: null }} />);
    expect(screen.getByText('Step 1 of 6 — Reading the records')).toBeInTheDocument();
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
