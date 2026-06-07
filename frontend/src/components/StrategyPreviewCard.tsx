import { useQuery } from '@tanstack/react-query';
import { getStrategyPreview, type StrategyTier } from '../api/strategy-preview';

// Pre-draft strategy preview: a deterministic, at-a-glance read of WHAT the draft will argue and how
// viable it is — so a human can catch a crazy pathway ("knee pain doesn't cause blindness") before
// spending on a draft. The tier + criteria come straight from the same engine the CDS uses; the steer to
// redirect lives in the Gate-1 checklist on "Send to Drafter".

const TIER_STYLE: Record<StrategyTier, { box: string; badge: string; label: string }> = {
  Strong: { box: 'border-emerald-300 border-l-emerald-500 bg-emerald-50', badge: 'bg-emerald-100 text-emerald-800', label: 'Strong' },
  Plausible: { box: 'border-sky-300 border-l-sky-500 bg-sky-50', badge: 'bg-sky-100 text-sky-800', label: 'Plausible' },
  Thin: { box: 'border-amber-300 border-l-amber-500 bg-amber-50', badge: 'bg-amber-100 text-amber-800', label: 'Thin' },
  Stop: { box: 'border-rose-300 border-l-rose-500 bg-rose-50', badge: 'bg-rose-100 text-rose-800', label: 'Stop — review' },
};

export function StrategyPreviewCard({ caseId }: { readonly caseId: string }) {
  const q = useQuery({
    queryKey: ['case', caseId, 'strategy-preview'],
    queryFn: () => getStrategyPreview(caseId),
    enabled: caseId.length > 0,
  });

  const p = q.data?.data;
  if (!p) return null; // quiet while loading / on error — the Send panel below carries its own state

  const s = TIER_STYLE[p.tier];
  return (
    <div className={`mb-4 rounded-lg border border-l-4 ${s.box} p-4`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-900">Strategy preview — before you draft</h3>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${s.badge}`}>{s.label}</span>
      </div>
      <p className="mt-2 text-sm text-slate-800"><span className="font-medium">Primary argument:</span> {p.primaryArgument}</p>
      {p.proposedMechanism ? (
        <p className="mt-1 text-sm text-slate-700"><span className="font-medium">Veteran’s stated theory:</span> {p.proposedMechanism}</p>
      ) : null}
      <ul className="mt-3 space-y-1">
        {p.criteria.map((c) => (
          <li key={c.key} className="flex items-start gap-2 text-xs">
            <span className={c.pass ? 'flex-none text-emerald-600' : 'flex-none text-rose-600'} aria-hidden="true">{c.pass ? '✓' : '✗'}</span>
            <span className="text-slate-700"><span className="font-medium">{c.label}.</span> {c.detail}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-slate-500">
        Deterministic sanity check from the chart — a relative ranking signal, not a win probability. If the
        argument is wrong, redirect it in the checklist when you click Send; your steer is binding.
      </p>
    </div>
  );
}
