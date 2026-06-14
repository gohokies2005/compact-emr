// E5 trustworthy viability (2026-06-13) — the three shared advisory pieces:
//   (1) INPUT VISIBILITY  — "Computed from N facts" + the disclosed fact set
//   (2) INTERMEDIARY CHAIN — a recovered SC → intermediary → claimed pathway, OR an honest "none found"
//   (3) COMPLETENESS SIGNAL — a caveat when part of the record went unparsed
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InputVisibility, ChainPathwayNote, CompletenessSignal } from '../components/ViabilityInputSet';
import type { StrategyInputSet, ChainAttempt } from '../api/strategy-preview';

describe('InputVisibility (the fact set the verdict was computed from)', () => {
  const inputSet: StrategyInputSet = {
    scConditions: ['PTSD', 'Tinnitus'],
    medications: [{ drugName: 'sertraline', indication: 'PTSD' }],
    activeProblems: ['OSA'],
    keyFacts: [{ label: 'Weight', value: '240 lb' }],
    factCount: 5,
  };

  it('shows the "Computed from N facts" headline with the correct count', () => {
    render(<InputVisibility inputSet={inputSet} />);
    expect(screen.getByText(/Computed from 5 facts/)).toBeInTheDocument();
  });

  it('discloses the exact SC conditions, meds (with indication), problems, and key facts on expand', () => {
    render(<InputVisibility inputSet={inputSet} />);
    fireEvent.click(screen.getByText(/Computed from 5 facts/));
    expect(screen.getByText(/PTSD, Tinnitus/)).toBeInTheDocument();
    expect(screen.getByText(/sertraline \(for PTSD\)/)).toBeInTheDocument();
    expect(screen.getByText(/Weight: 240 lb/)).toBeInTheDocument();
  });

  it('flags an empty SC list so a missing condition is obvious (the thin-parse tell)', () => {
    render(<InputVisibility inputSet={{ scConditions: [], medications: [], activeProblems: [], keyFacts: [], factCount: 0 }} />);
    expect(screen.getByText(/Computed from 0 facts/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Computed from 0 facts/));
    expect(screen.getByText(/verify the chart parsed the rating decision/)).toBeInTheDocument();
  });
});

describe('ChainPathwayNote (intermediary check)', () => {
  it('surfaces a recovered SC → intermediary → claimed pathway', () => {
    const attempt: ChainAttempt = {
      searched: true,
      pathway: {
        anchor: 'Tinnitus',
        intermediary: 'Anxiety / GAD',
        hops: [
          { from: 'Tinnitus', to: 'Anxiety / GAD', tier: 'moderate' },
          { from: 'Anxiety / GAD', to: 'Hypertension', tier: 'moderate' },
        ],
        intermediarySource: 'comorbid_dx',
      },
    };
    render(<ChainPathwayNote chainAttempt={attempt} />);
    expect(screen.getByText(/Indirect pathway found/)).toBeInTheDocument();
    expect(screen.getByText(/Tinnitus/)).toBeInTheDocument();
    expect(screen.getByText(/a comorbid diagnosis/)).toBeInTheDocument();
  });

  it('labels a med-bridged chain as treated by a current medication', () => {
    const attempt: ChainAttempt = {
      searched: true,
      pathway: {
        anchor: 'Tinnitus', intermediary: 'Anxiety / GAD',
        hops: [
          { from: 'Tinnitus', to: 'Anxiety / GAD', tier: 'moderate' },
          { from: 'Anxiety / GAD', to: 'Hypertension', tier: 'moderate' },
        ],
        intermediarySource: 'medication_indication',
      },
    };
    render(<ChainPathwayNote chainAttempt={attempt} />);
    expect(screen.getByText(/treated by a current medication/)).toBeInTheDocument();
  });

  it('renders an honest "searched, none found" when no chain exists', () => {
    render(<ChainPathwayNote chainAttempt={{ searched: true, pathway: null }} />);
    expect(screen.getByText(/also checked indirect \(two-step\) pathways/)).toBeInTheDocument();
    expect(screen.getByText(/none recognized on record/)).toBeInTheDocument();
  });
});

describe('CompletenessSignal (a thin parse never masquerades as confident)', () => {
  it('warns when files went unread', () => {
    render(<CompletenessSignal state={{ unreadFileCount: 2, uncoveredPages: 0, truncatedWindows: 0 }} />);
    expect(screen.getByText(/2 files not read/)).toBeInTheDocument();
    expect(screen.getByText(/verdict may be incomplete/)).toBeInTheDocument();
  });

  it('warns when pages went unparsed (the Woodley 1,119pp class)', () => {
    render(<CompletenessSignal state={{ unreadFileCount: 0, uncoveredPages: 340, truncatedWindows: 1 }} />);
    expect(screen.getByText(/340 pages not parsed/)).toBeInTheDocument();
    expect(screen.getByText(/1 dense section partially parsed/)).toBeInTheDocument();
  });

  it('renders nothing when the chart is complete (no gaps, no unread files)', () => {
    const { container } = render(<CompletenessSignal state={{ unreadFileCount: 0, uncoveredPages: 0, truncatedWindows: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when completeness is unknown (null)', () => {
    const { container } = render(<CompletenessSignal state={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
