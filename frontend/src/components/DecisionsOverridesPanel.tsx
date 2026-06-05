import { useQuery } from '@tanstack/react-query';
import { getDraftDecisions } from '../api/drafter';
import { formatRelativeTime } from '../lib/date';

/**
 * In-chart "Decisions & overrides" log — Gate-1 attestations, Gate-2 halt findings, and every RN
 * override/switch/proceed, with the FULL typed reason, who, and when. Per the owner's hard rule:
 * every override reason must be visible in the chart, never log-only. Renders nothing if empty.
 */
export function DecisionsOverridesPanel({ caseId }: { readonly caseId: string }) {
  const q = useQuery({ queryKey: ['case', caseId, 'draft-decisions'], queryFn: () => getDraftDecisions(caseId), enabled: caseId.length > 0 });
  const rows = q.data?.data ?? [];
  if (rows.length === 0) return null;
  const label = (d: { gate: number; decision: string }): string => `${d.gate === 1 ? 'Checklist' : 'AI check'} · ${d.decision}`;
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3"><h3 className="text-sm font-semibold text-slate-800">Decisions &amp; overrides</h3></div>
      <div className="divide-y divide-slate-100">
        {rows.map((d) => (
          <div key={d.id} className="px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-slate-800">{d.item} <span className="font-normal text-slate-500">— {label(d)}</span></span>
              <span className="shrink-0 text-xs text-slate-400">{d.rnUser} · {formatRelativeTime(d.createdAt)}</span>
            </div>
            {d.reason ? <p className="mt-1 text-slate-600">{d.reason}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
