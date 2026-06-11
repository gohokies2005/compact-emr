// ONE band→chip mapping for every surface that renders a viability band (P1 re-source 2026-06-11):
// CaseViabilityCard owned this map first; StrategyPreviewCard now band-drives its headline chip too.
// Plain-language band words only — never a BVA n / % / win-rate / atlas tier (CLAUDE.md #17; the
// guard is structural in the vendored resolver).
import type { ViabilityBand } from '../api/case-viability';
import type { ChipTone } from '../components/ui/StatusChip';

export const BAND_CHIP: Record<ViabilityBand, { tone: ChipTone; label: string }> = {
  strong: { tone: 'good', label: 'Strong' },
  moderate: { tone: 'good', label: 'Moderate' },
  conditional: { tone: 'warn', label: 'Conditional' },
  weak: { tone: 'bad', label: 'Weak' },
  abstain: { tone: 'neutral', label: 'Needs RN review' },
  redirect: { tone: 'info', label: 'Redirect' },
};
