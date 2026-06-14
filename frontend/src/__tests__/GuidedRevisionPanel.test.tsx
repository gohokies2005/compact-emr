import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuidedRevisionPanel } from '../components/GuidedRevisionPanel';
import { proposeGuidedRevision } from '../api/letter';
import { ServiceUnavailableError, SurgicalEditUnappliableError } from '../api/client';

// Guided Revision UI (2026-06-13): unit-tests for the highlight→propose→inspect→accept panel.
// The API client is mocked so we drive each backend outcome (success, dropped-citation warning,
// 422 citation_invented rejection, 503 flag-off) and assert the SAFE surfacing + Accept gating.
vi.mock('../api/letter', () => ({ proposeGuidedRevision: vi.fn() }));
const proposeMock = vi.mocked(proposeGuidedRevision);

const FIND = { timeout: 5000 } as const;
const PROPOSAL = { operation: 'replace' as const, anchor_text: 'the claimed condition', new_text: 'the claimed condition (tightened)' };

function okResult(over: Partial<Parameters<typeof proposeMock.mockResolvedValue>[0]['data']> = {}) {
  return {
    data: {
      mode: 'guided_revision' as const,
      proposal: PROPOSAL,
      preview: 'Full revised letter text.',
      warnings: [] as string[],
      sanity: [] as { rule: string; detail: string }[],
      citationDiff: { added: [], removed: [] },
      costUsd: 0.31,
      model: 'claude-opus-4-8',
      ...over,
    },
  };
}

function renderPanel(over: Partial<React.ComponentProps<typeof GuidedRevisionPanel>> = {}) {
  const onApply = over.onApply ?? vi.fn().mockResolvedValue(undefined);
  const onFlagDisabled = over.onFlagDisabled ?? vi.fn();
  render(
    <GuidedRevisionPanel
      caseId="CASE-1"
      passage={'the claimed condition'}
      disabledByFlag={false}
      onApply={onApply}
      onFlagDisabled={onFlagDisabled}
      {...over}
    />,
  );
  return { onApply, onFlagDisabled };
}

async function fillAndPropose() {
  fireEvent.change(screen.getByPlaceholderText('Example: tighten this paragraph and lead with the mechanism.'), { target: { value: 'Tighten this.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Propose revision' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  proposeMock.mockResolvedValue(okResult());
});

describe('GuidedRevisionPanel', () => {
  it('proposes and renders the diff/preview + enables Accept', async () => {
    renderPanel();
    await fillAndPropose();
    expect(await screen.findByText('Full revised letter text.', undefined, FIND)).toBeInTheDocument();
    expect(proposeMock).toHaveBeenCalledWith('CASE-1', { passage: 'the claimed condition', instruction: 'Tighten this.' });
    const accept = screen.getByRole('button', { name: 'Accept revision' });
    expect(accept).toBeEnabled();
  });

  it('surfaces a removed-citation warning the doctor must acknowledge', async () => {
    proposeMock.mockResolvedValue(okResult({ citationDiff: { added: [], removed: [{ kind: 'author_year', key: 'el-serag 2014', raw: 'El-Serag 2014' }] } }));
    renderPanel();
    await fillAndPropose();
    expect(await screen.findByText(/This revision drops a citation/i, undefined, FIND)).toBeInTheDocument();
    expect(screen.getByText('El-Serag 2014')).toBeInTheDocument();
    // Accept is still allowed for a DROPPED citation (the doctor decides) — only INVENTED blocks.
    expect(screen.getByRole('button', { name: 'Accept revision' })).toBeEnabled();
  });

  it('surfaces backend warnings + sanity findings', async () => {
    proposeMock.mockResolvedValue(okResult({
      warnings: ['This revision removes 1 citation/statistic from the passage. Confirm this is intended.'],
      sanity: [{ rule: 'short_letter', detail: 'Letter appears unusually short.' }],
    }));
    renderPanel();
    await fillAndPropose();
    expect(await screen.findByText(/Confirm this is intended/i, undefined, FIND)).toBeInTheDocument();
    expect(screen.getByText('Letter appears unusually short.')).toBeInTheDocument();
  });

  it('renders a 422 citation_invented rejection and shows NO Accept button', async () => {
    proposeMock.mockRejectedValue(new SurgicalEditUnappliableError({ reason: 'citation_invented', citationDiff: { added: [{ raw: 'Smith 2020' }], removed: [] } }));
    renderPanel();
    await fillAndPropose();
    expect(await screen.findByText(/introduced a citation\/statistic not in the original \(Smith 2020\)/i, undefined, FIND)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept revision' })).not.toBeInTheDocument();
  });

  it('renders a 422 holding_changed rejection with the locked-opinion copy and no Accept', async () => {
    proposeMock.mockRejectedValue(new SurgicalEditUnappliableError({ reason: 'holding_changed' }));
    renderPanel();
    await fillAndPropose();
    expect(await screen.findByText(/change the opinion’s conclusion/i, undefined, FIND)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept revision' })).not.toBeInTheDocument();
  });

  it('prompts to re-select on a 422 passage_not_found', async () => {
    proposeMock.mockRejectedValue(new SurgicalEditUnappliableError({ reason: 'passage_not_found' }));
    renderPanel();
    await fillAndPropose();
    expect(await screen.findByText(/re-select the text and try again/i, undefined, FIND)).toBeInTheDocument();
  });

  it('on a 503 disables the entry point (calls onFlagDisabled) and shows the not-enabled copy', async () => {
    proposeMock.mockRejectedValue(new ServiceUnavailableError());
    const { onFlagDisabled } = renderPanel();
    await fillAndPropose();
    expect(await screen.findByText(/isn’t enabled yet/i, undefined, FIND)).toBeInTheDocument();
    expect(onFlagDisabled).toHaveBeenCalledTimes(1);
  });

  it('hides the entry point entirely when disabledByFlag is set', () => {
    renderPanel({ disabledByFlag: true });
    expect(screen.queryByRole('button', { name: 'Propose revision' })).not.toBeInTheDocument();
    expect(screen.getByText(/isn’t enabled in this environment/i)).toBeInTheDocument();
  });

  it('disables Propose until a passage is selected AND an instruction is typed', () => {
    renderPanel({ passage: null });
    expect(screen.getByText('Select text in the letter to revise it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Propose revision' })).toBeDisabled();
  });

  it('Accept calls onApply with the proposal (shared surgical apply door)', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onApply });
    await fillAndPropose();
    await screen.findByText('Full revised letter text.', undefined, FIND);
    fireEvent.click(screen.getByRole('button', { name: 'Accept revision' }));
    await waitFor(() => { expect(onApply).toHaveBeenCalledWith(PROPOSAL); });
  });
});
