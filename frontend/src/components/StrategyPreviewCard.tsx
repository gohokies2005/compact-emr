import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getStrategyPreview, type StrategyTier } from '../api/strategy-preview';
import { StatusChip, type ChipTone } from './ui/StatusChip';
import { BAND_CHIP } from '../lib/viabilityChip';

// Pre-draft strategy section. NEUTRAL by design (architect/nurse/UI review 2026-06-07): it never wears a
// blocker color and never gates the button — that's chart-readiness' job. The only color here is a small
// advisory tier chip. Shows the primary argument, a SUGGESTED pathway when a stronger one exists, the
// veteran's own stated theory, and the 5 checks collapsed behind a disclosure (auto-shown only when the
// tier is concerning). One verdict, no conflicting traffic lights.

// Advisory tier chip → shared Aegis StatusChip tone. Strong=good, Plausible=info, Thin=warn, Stop=bad.
const TIER_CHIP: Record<StrategyTier, { tone: ChipTone; label: string }> = {
  Strong: { tone: 'good', label: 'Strong' },
  Plausible: { tone: 'info', label: 'Plausible' },
  Thin: { tone: 'warn', label: 'Thin — review' },
  Stop: { tone: 'bad', label: 'Review needed' },
};

export function StrategyPreviewCard({ caseId, chartReady }: { readonly caseId: string; readonly chartReady?: boolean }) {
  const q = useQuery({
    queryKey: ['case', caseId, 'strategy-preview'],
    queryFn: () => getStrategyPreview(caseId),
    enabled: caseId.length > 0,
  });
  const [showDetail, setShowDetail] = useState(false);

  const p = q.data?.data;
  if (!p || !p.evaluable) return null; // quiet on load/error and on untriaged cases

  // While the chart is still scanning, the data-dependent checks (esp. diagnosis, which reads the extracted
  // problem list) aren't confirmed yet — show a neutral "analyzing" state instead of a premature ✗ / a
  // "Review needed" tier that flips to ✓ once OCR lands a minute later (Ryan 2026-06-08).
  const unconfirmed = chartReady === false;
  // P1 re-source (2026-06-11): on a SECONDARY claim (p.anchor set) with a viability read, the headline
  // chip is the plain-language BAND (Strong/Moderate/Conditional/Weak/…) — one sha-pinned engine, no
  // BVA numbers. A hard-gate Stop (no dx / barred / no anchor) still wins the chip: the band engine is
  // info-light and cannot see a missing diagnosis. Direct claims (anchor null) keep the legacy tier
  // chip — the engine answers "which anchor", not direct-claim strength. Fail-open (viability null) =
  // legacy tier chip.
  const v = p.viability ?? null;
  const bandChip = v !== null && p.anchor !== null && p.tier !== 'Stop' ? BAND_CHIP[v.viability] : null;
  const chip: { tone: ChipTone; label: string } = unconfirmed
    ? { tone: 'neutral', label: 'Analyzing chart…' }
    : bandChip ?? TIER_CHIP[p.tier];
  const concerning = !unconfirmed && (p.tier === 'Stop' || p.tier === 'Thin');
  const rec = p.recommendedPathway;
  // Aggravation-only re-characterization (FRN engine 5d04b62): surface the 3.310(b)-only framing as a
  // single sentence sourced from the engine's why (Ryan ratified the framing 2026-06-11).
  const aggravationOnly = v?.best_anchor?.aggravation_only === true;
  const whyFirstSentence = v !== null && v.why.includes('. ') ? v.why.slice(0, v.why.indexOf('. ') + 1) : v?.why ?? '';

  return (
    <div className="mb-5 border-b border-aegis pb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-slate-800"><span className="font-medium">Argument:</span> {p.primaryArgument}</div>
          {rec.kind === 'secondary' && rec.differsFromCurrent && rec.anchor !== p.anchor ? (
            <div className="mt-1 text-sm text-slate-500">
              <span className="font-medium">Anticipated:</span> likely stronger as <span className="font-medium">secondary to {rec.anchor}</span>
              {rec.basis ? ` (${rec.basis})` : ''}. FYI — the drafter weighs this.
            </div>
          ) : null}
          {aggravationOnly ? (
            <div className="mt-1 text-sm text-slate-700">
              <span className="font-medium">Argue aggravation (3.310(b)):</span> {whyFirstSentence}
            </div>
          ) : null}
          {p.proposedMechanism ? (
            <div className="mt-1 text-sm text-slate-600"><span className="font-medium">Veteran’s theory:</span> {p.proposedMechanism}</div>
          ) : null}
          {unconfirmed ? (
            // TODO(doc-pipeline): thread extracted/total counts from chart-readiness to render "(N of M)".
            <div className="mt-1 text-xs text-amber-700">
              Documents not yet extracted — checks may change once OCR completes.
            </div>
          ) : null}
        </div>
        <StatusChip tone={chip.tone} className="shrink-0">
          <span title="Advisory only — does not block drafting">{chip.label}</span>
        </StatusChip>
      </div>

      <button type="button" onClick={() => setShowDetail((s) => !s)} className="mt-2 text-xs text-slate-400 hover:text-slate-600">
        {showDetail ? 'Hide checks ▲' : `Strategy checks (${p.criteria.length}) ▼`}
      </button>
      {showDetail || concerning ? (
        <ul className="mt-2 space-y-1">
          {p.criteria.map((c) => {
            const pending = unconfirmed && !c.pass; // not yet confirmed while the chart is still scanning
            const amber = !pending && !c.pass && c.tone === 'amber'; // P1e: stated-but-uncorroborated — △, not ✗
            return (
              <li key={c.key} className="flex items-start gap-2 text-xs">
                {pending ? (
                  <span className="flex-none text-slate-300" aria-hidden="true">○</span>
                ) : amber ? (
                  <span className="flex-none text-amber-600" aria-hidden="true">△</span>
                ) : (
                  <span className={c.pass ? 'flex-none text-emerald-600' : 'flex-none text-rose-600'} aria-hidden="true">{c.pass ? '✓' : '✗'}</span>
                )}
                <span className={amber ? 'text-amber-700' : 'text-slate-600'}>
                  <span className="font-medium">{c.label}.</span>{' '}
                  {pending ? <span className="italic text-slate-400">checking the chart…</span> : c.detail}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
