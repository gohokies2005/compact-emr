// StrategyPreviewCard — QUIET argument/theory summary locks (verdict surfaces removed 2026-06-29):
//   (i)   NO redundant band/tier chip; argument body renders; no BVA % / n= anywhere
//   (ii)  aggravation-only (HTN+PTSD shape) renders the 3.310(b) framing sentence, still no numbers
//   (iii) viability null → argument/theory copy, no chip, no crash (fail-open)
//   (v)   chartReady=false renders the "documents not yet extracted" caution
// (former (iv) — the amber ✓/△/✗ "Strategy checks" checklist — was REMOVED: the brittle cdsEngine
//  verdict checklist + tier chip + auto-expand were retired so the SOAP card is the single pre-draft
//  signal. The card now carries no ✓/⚠ verdict; see CaseDetailPage.storyOrder for the on-page lock.)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyPreviewCard } from '../components/StrategyPreviewCard';
import { getStrategyPreview, type StrategyPreview } from '../api/strategy-preview';
import type { CaseViability } from '../api/case-viability';

vi.mock('../api/strategy-preview', async () => {
  const actual = await vi.importActual<typeof import('../api/strategy-preview')>('../api/strategy-preview');
  return { ...actual, getStrategyPreview: vi.fn() };
});

const previewMock = vi.mocked(getStrategyPreview);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function viability(over: Partial<CaseViability>): CaseViability {
  return {
    version: 1,
    claimed_canonical: 'Obstructive sleep apnea',
    viability: 'strong',
    best_anchor: {
      upstream_canonical: 'PTSD', upstream_verbatim: 'PTSD', M_static: 4, M_eff: 4, E: null,
      tier: 'blessed', basis: '3.310a', is_granted_sc: true, mechanism_class: null, requires: null,
    },
    alternatives: [],
    why: 'Strong: service-connected PTSD is a dominant recognized cause of Obstructive sleep apnea.',
    missing_fact: null,
    presumptive_redirect: null,
    graveyard_redirect: null,
    excluded_traps: [],
    confidence: 'high',
    mode: 'info_light',
    table_version: '2026-06-10.2',
    table_content_hash: 'pin',
    ...over,
  };
}

function preview(over: Partial<StrategyPreview>): StrategyPreview {
  return {
    evaluable: true,
    recommendedPathway: { kind: 'direct', anchor: null, basis: null, differsFromCurrent: false },
    primaryArgument: 'OSA — secondary to service-connected PTSD (causation)',
    proposedMechanism: null,
    anchor: 'PTSD',
    tier: 'Plausible',
    criteria: [
      { key: 'diagnosis', label: 'Current diagnosis on file', pass: true, detail: '1 active problem(s) recorded' },
      { key: 'strength', label: 'No adverse strength signal', pass: true, detail: 'Strong: service-connected PTSD is a dominant recognized cause of Obstructive sleep apnea.' },
    ],
    summary: 'Recognized pathway with no adverse signal on record.',
    ...over,
  };
}

function mount(p: StrategyPreview, chartReady: boolean | undefined = true) {
  previewMock.mockResolvedValue({ data: p });
  return render(<StrategyPreviewCard caseId="CASE-1" chartReady={chartReady} />, { wrapper });
}

function mountWithCompleteness(
  p: StrategyPreview,
  completeness: { unreadFileCount: number; uncoveredPages: number; truncatedWindows: number } | null,
) {
  previewMock.mockResolvedValue({ data: p });
  return render(<StrategyPreviewCard caseId="CASE-1" chartReady={true} completeness={completeness} />, { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StrategyPreviewCard — viability re-source', () => {
  it('(i) chip-reconciliation: a positive band shows NO redundant chip on Background (strength lives in Anchor viability), and renders NO BVA % / n=', async () => {
    // Chip-reconciliation (RN QA 2026-06-16): a non-concerning positive band ("Strong") must NOT render
    // a Background chip — it would duplicate the Anchor-viability chip and look like it contradicts the
    // Recommended-plan action. The argument body still renders; only the redundant chip is gone.
    mount(preview({ tier: 'Plausible', viability: viability({ viability: 'strong' }) }));
    expect(await screen.findByText(/Argument:/)).toBeInTheDocument();
    expect(screen.queryByText('Strong')).not.toBeInTheDocument(); // no redundant band chip
    expect(screen.queryByText('Plausible')).not.toBeInTheDocument();
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/\d+(\.\d+)?%/);
    expect(body).not.toMatch(/\bn=\d/);
    expect(body).not.toMatch(/decided Board appeals/i);
  });

  it('(ii) aggravation-only (HTN+PTSD shape) renders the 3.310(b) framing sentence, no numbers', async () => {
    const why = 'Aggravation only: argue that service-connected PTSD AGGRAVATED Hypertension under 38 CFR 3.310(b) (a secondary argument); do NOT argue direct causation — the VA reliably denies it. Lead with a causation anchor if one is service-connected.';
    mount(preview({
      tier: 'Plausible',
      primaryArgument: 'Hypertension — secondary to service-connected PTSD (aggravation)',
      viability: viability({
        viability: 'conditional',
        claimed_canonical: 'Hypertension',
        why,
        best_anchor: {
          upstream_canonical: 'PTSD', upstream_verbatim: 'PTSD', M_static: 2, M_eff: 2, E: null,
          tier: 'conditional', basis: '3.310b', is_granted_sc: true, mechanism_class: null, requires: 'Documented HTN.',
          aggravation_only: true, causation_denied: true,
        },
      }),
    }));
    // (chip-reconciliation) the positive "Conditional" band no longer shows as a redundant Background
    // chip; the aggravation framing + reasoning still render in the body.
    expect(await screen.findByText(/Argue aggravation \(3\.310\(b\)\)/)).toBeInTheDocument();
    expect(screen.queryByText('Conditional')).not.toBeInTheDocument();
    expect(screen.getByText(/AGGRAVATED Hypertension/)).toBeInTheDocument();
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/\d+(\.\d+)?%/);
    expect(body).not.toMatch(/\bn=\d/);
    expect(body).not.toMatch(/tier (high|moderate|low)/i);
  });

  it('(iii) viability null falls back to the criteria copy without crashing (positive tier shows no Background chip)', async () => {
    mount(preview({ tier: 'Plausible', viability: null }));
    expect(await screen.findByText(/Argument:/)).toBeInTheDocument();
    expect(screen.queryByText('Plausible')).not.toBeInTheDocument(); // non-concerning tier → no redundant chip
    expect(screen.queryByText(/Argue aggravation/)).not.toBeInTheDocument();
  });

  it('(iv-removed) renders NO ✓/△/✗ verdict checklist even on a concerning/amber criterion', async () => {
    // The brittle cdsEngine "Strategy checks" checklist + tier chip + auto-expand were retired
    // (2026-06-29) so the SOAP card is the single pre-draft signal. A criterion that would previously
    // have rendered an amber △ (or a red ✗, or the "Strategy checks" toggle) must now render NOTHING —
    // the card is a quiet argument/theory summary with no verdict glyphs.
    mount(preview({
      tier: 'Thin', // would previously have auto-expanded the checklist
      anchor: null,
      viability: null,
      criteria: [
        { key: 'anchor', label: 'In-service event documented', pass: false, tone: 'amber', detail: 'Veteran states an in-service exposure — not yet corroborated in the record; verify the DD-214/service records before drafting.' },
      ],
    }));
    expect(await screen.findByText(/Argument:/)).toBeInTheDocument();
    expect(screen.queryByText('△')).not.toBeInTheDocument();
    expect(screen.queryByText('✗')).not.toBeInTheDocument();
    expect(screen.queryByText(/Strategy checks/)).not.toBeInTheDocument();
    expect(screen.queryByText('Thin — review')).not.toBeInTheDocument();
    expect(screen.queryByText('Review needed')).not.toBeInTheDocument();
    expect(screen.queryByText(/not yet corroborated/)).not.toBeInTheDocument();
  });

  it('(v) chartReady=false renders the "documents not yet extracted" caution', async () => {
    mount(preview({ tier: 'Plausible', viability: null }), false);
    expect(await screen.findByText(/Documents not yet extracted — this summary may change once OCR completes\./)).toBeInTheDocument();
  });
});

describe('StrategyPreviewCard — E5 trustworthy viability (2026-06-13)', () => {
  it('renders the input-visibility "Computed from N facts" line from the payload inputSet', async () => {
    mount(preview({
      tier: 'Plausible', viability: null,
      inputSet: {
        scConditions: ['PTSD'], medications: [{ drugName: 'sertraline', indication: 'PTSD' }],
        activeProblems: ['OSA'], keyFacts: [{ label: 'Weight', value: '240 lb' }], factCount: 4,
      },
    }));
    expect(await screen.findByText(/Computed from 4 facts/)).toBeInTheDocument();
  });

  it('surfaces the intermediary chain when a direct decline recovered a two-hop pathway', async () => {
    mount(preview({
      tier: 'Thin', viability: null,
      chainAttempt: {
        searched: true,
        pathway: {
          anchor: 'Tinnitus', intermediary: 'Anxiety / GAD',
          hops: [
            { from: 'Tinnitus', to: 'Anxiety / GAD', tier: 'moderate' },
            { from: 'Anxiety / GAD', to: 'Hypertension', tier: 'moderate' },
          ],
          intermediarySource: 'comorbid_dx',
        },
      },
    }));
    expect(await screen.findByText(/Indirect pathway found/)).toBeInTheDocument();
  });

  it('shows the completeness caveat when part of the record went unparsed', async () => {
    mountWithCompleteness(preview({ tier: 'Thin', viability: null }), { unreadFileCount: 1, uncoveredPages: 0, truncatedWindows: 0 });
    expect(await screen.findByText(/verdict may be incomplete/)).toBeInTheDocument();
    expect(screen.getByText(/1 file not read/)).toBeInTheDocument();
  });

  it('renders no completeness caveat when the chart is complete', async () => {
    mountWithCompleteness(preview({ tier: 'Plausible', viability: null }), { unreadFileCount: 0, uncoveredPages: 0, truncatedWindows: 0 });
    expect(await screen.findByText(/Argument:/)).toBeInTheDocument();
    expect(screen.queryByText(/verdict may be incomplete/)).not.toBeInTheDocument();
  });
});
