import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getStrategyPreview, type StrategyTier } from '../api/strategy-preview';

// Pre-draft strategy section. NEUTRAL by design (architect/nurse/UI review 2026-06-07): it never wears a
// blocker color and never gates the button — that's chart-readiness' job. The only color here is a small
// advisory tier chip. Shows the primary argument, a SUGGESTED pathway when a stronger one exists, the
// veteran's own stated theory, and the 5 checks collapsed behind a disclosure (auto-shown only when the
// tier is concerning). One verdict, no conflicting traffic lights.

const TIER_CHIP: Record<StrategyTier, { cls: string; label: string }> = {
  Strong: { cls: 'bg-emerald-100 text-emerald-800', label: 'Strong' },
  Plausible: { cls: 'bg-sky-100 text-sky-800', label: 'Plausible' },
  Thin: { cls: 'bg-amber-100 text-amber-800', label: 'Thin — review' },
  Stop: { cls: 'bg-rose-100 text-rose-800', label: 'Review needed' },
};

export function StrategyPreviewCard({ caseId }: { readonly caseId: string }) {
  const q = useQuery({
    queryKey: ['case', caseId, 'strategy-preview'],
    queryFn: () => getStrategyPreview(caseId),
    enabled: caseId.length > 0,
  });
  const [showDetail, setShowDetail] = useState(false);

  const p = q.data?.data;
  if (!p || !p.evaluable) return null; // quiet on load/error and on untriaged cases

  const chip = TIER_CHIP[p.tier];
  const concerning = p.tier === 'Stop' || p.tier === 'Thin';
  const rec = p.recommendedPathway;

  return (
    <div className="mb-5 border-b border-slate-100 pb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-slate-800"><span className="font-medium">Argument:</span> {p.primaryArgument}</div>
          {rec.kind === 'secondary' && rec.differsFromCurrent && rec.anchor !== p.anchor ? (
            <div className="mt-1 text-sm text-slate-500">
              <span className="font-medium">Anticipated:</span> likely stronger as <span className="font-medium">secondary to {rec.anchor}</span>
              {rec.basis ? ` (${rec.basis})` : ''}. FYI — the drafter weighs this.
            </div>
          ) : null}
          {p.proposedMechanism ? (
            <div className="mt-1 text-sm text-slate-600"><span className="font-medium">Veteran’s theory:</span> {p.proposedMechanism}</div>
          ) : null}
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${chip.cls}`} title="Advisory only — does not block drafting">
          {chip.label}
        </span>
      </div>

      <button type="button" onClick={() => setShowDetail((s) => !s)} className="mt-2 text-xs text-slate-400 hover:text-slate-600">
        {showDetail ? 'Hide checks ▲' : `Strategy checks (${p.criteria.length}) ▼`}
      </button>
      {showDetail || concerning ? (
        <ul className="mt-2 space-y-1">
          {p.criteria.map((c) => (
            <li key={c.key} className="flex items-start gap-2 text-xs">
              <span className={c.pass ? 'flex-none text-emerald-600' : 'flex-none text-rose-600'} aria-hidden="true">{c.pass ? '✓' : '✗'}</span>
              <span className="text-slate-600"><span className="font-medium">{c.label}.</span> {c.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
