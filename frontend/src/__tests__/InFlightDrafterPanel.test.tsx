import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InFlightDrafterPanel, type InFlightDraftJob } from '../components/InFlightDrafterPanel';

vi.mock('../lib/date', () => ({
  formatRelativeTime: (value: string) => value,
}));

// Fixture matches our actual DraftJob shape (no `failedAt`, optional-not-nullable
// completedAt/errorMessage — omit instead of passing null).
const runningJob: InFlightDraftJob = {
  id: 'draft-job-1',
  caseId: 'CASE-1',
  state: 'running',
  version: 1,
  enqueuedAt: '2026-05-25T12:00:00.000Z',
  startedAt: '2026-05-25T12:01:00.000Z',
  updatedAt: '2026-05-25T12:01:00.000Z',
  currentPhase: 'drafter',
  nextRetryInS: null,
};

describe('InFlightDrafterPanel', () => {
  it('renders the mapped message for a running drafter phase', () => {
    render(<InFlightDrafterPanel job={runningJob} />);

    expect(screen.getByText('Drafting the letter...')).toBeInTheDocument();
    expect(screen.getByText('Drafting the opinion.')).toBeInTheDocument();
    expect(screen.getByText(/Started 2026-05-25T12:01:00.000Z/)).toBeInTheDocument();
  });

  it('appends the retry message when nextRetryInS is positive', () => {
    render(<InFlightDrafterPanel job={{ ...runningJob, currentPhase: 'pmid_verify', nextRetryInS: 30 }} />);

    expect(
      screen.getByText(
        "Verifying every citation. Taking a bit longer - we're re-running this step automatically.",
      ),
    ).toBeInTheDocument();
  });

  it('falls back to getting started when phase is unset', () => {
    render(<InFlightDrafterPanel job={{ ...runningJob, currentPhase: null }} />);

    expect(screen.getByText('Getting started.')).toBeInTheDocument();
  });
});
