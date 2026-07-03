import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CitationEnricherPanel } from '../components/CitationEnricherPanel';
import { proposeCitationEnrich, pollCitationEnrich, applyCitationEnrich } from '../api/letter';

// Feature B — Citation Enricher panel (PHYSICIAN-ONLY). Drives the async propose → poll → ready →
// select → apply flow with the api mocked, and pins the page-level role gating (ops_staff never sees
// the panel — the parent renders it only when canPhysicianAct).

vi.mock('../api/letter', () => ({
  proposeCitationEnrich: vi.fn(),
  pollCitationEnrich: vi.fn(),
  applyCitationEnrich: vi.fn(),
}));
const proposeMock = vi.mocked(proposeCitationEnrich);
const pollMock = vi.mocked(pollCitationEnrich);
const applyMock = vi.mocked(applyCitationEnrich);

const CANDIDATE = {
  pmid: '22222222',
  title: 'OSA and PTSD: a cohort study',
  journal: 'J Sleep',
  year: '2020',
  killer_finding: 'OSA prevalence was elevated in veterans with PTSD.',
  pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/22222222/',
  slot: 'A2' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  proposeMock.mockResolvedValue({ data: { jobId: 'JOB-1', status: 'pending' } });
  pollMock.mockResolvedValue({ data: { status: 'ready', candidates: [CANDIDATE] } });
  applyMock.mockResolvedValue({ data: { version: 2, txt: 'new', insertedPmids: ['22222222'], warnings: [] } });
});

describe('CitationEnricherPanel', () => {
  it('finds candidates (propose → poll), then adds a selected one (apply) + calls onApplied', async () => {
    const onApplied = vi.fn();
    render(<CitationEnricherPanel caseId="CASE-1" passage={null} onApplied={onApplied} />);

    fireEvent.change(screen.getByPlaceholderText(/obstructive sleep apnea/i), { target: { value: 'OSA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find citations' }));

    // The grounded candidate appears after the (mocked) poll resolves.
    expect(await screen.findByText('OSA and PTSD: a cohort study', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/OSA prevalence was elevated/)).toBeInTheDocument();
    expect(proposeMock).toHaveBeenCalledWith('CASE-1', { condition: 'OSA' });

    // Select the candidate + add it.
    fireEvent.click(screen.getByLabelText('Add citation PMID 22222222'));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected' }));

    // BUG 2 (Spring): no groundInSectionVi — citations always go to §VIII, never a generic §VI sentence.
    await waitFor(() => expect(applyMock).toHaveBeenCalledWith('CASE-1', { jobId: 'JOB-1', selectedPmids: ['22222222'] }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('DIRECT-PMID: "Fetch by PMID" proposes { pmid } and previews the resolved candidate', async () => {
    render(<CitationEnricherPanel caseId="CASE-1" passage={null} onApplied={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/PubMed ID/i), { target: { value: '31393195' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch by PMID' }));

    expect(await screen.findByText('OSA and PTSD: a cohort study', undefined, { timeout: 5000 })).toBeInTheDocument();
    // digits-only extraction; no claim/condition keys are sent on the by-PMID path.
    expect(proposeMock).toHaveBeenCalledWith('CASE-1', { pmid: '31393195' });
  });

  it('surfaces a "could not be re-verified" message when apply 422s (citation_unverified)', async () => {
    // The real typed error the api client throws on a 422 — the panel branches on instanceof.
    const { SurgicalEditUnappliableError } = await import('../api/client');
    applyMock.mockRejectedValueOnce(new SurgicalEditUnappliableError({ reason: 'citation_unverified' }));

    render(<CitationEnricherPanel caseId="CASE-1" passage={null} onApplied={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/obstructive sleep apnea/i), { target: { value: 'OSA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find citations' }));
    await screen.findByText('OSA and PTSD: a cohort study', undefined, { timeout: 5000 });
    fireEvent.click(screen.getByLabelText('Add citation PMID 22222222'));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected' }));
    expect(await screen.findByText(/could not be re-verified/i, undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  // Page-level role gate: the LetterEditorPage renders the enricher only when canPhysicianAct. Pin
  // both arms with the same gating expression the page uses.
  function PageGate({ role }: { role: 'physician' | 'ops_staff' | 'admin' }) {
    const canPhysicianAct = role === 'physician' || role === 'admin';
    return <div>{canPhysicianAct ? <CitationEnricherPanel caseId="CASE-1" passage={null} onApplied={vi.fn()} /> : null}</div>;
  }

  it('a physician SEES the Citation Enricher; an ops_staff (RN) does NOT', () => {
    const { rerender } = render(<PageGate role="physician" />);
    expect(screen.getByText('Citation Enricher')).toBeInTheDocument();
    rerender(<PageGate role="ops_staff" />);
    expect(screen.queryByText('Citation Enricher')).not.toBeInTheDocument();
  });
});
