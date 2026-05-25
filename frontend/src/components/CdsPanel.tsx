import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { runCds, type CaseDetail, type CdsResult } from '../api/cases';
import { formatRelativeTime } from '../lib/date';
import type { CdsVerdict } from '../types/prisma';

interface CdsPanelProps {
  readonly caseId: string;
  readonly verdict: CdsVerdict;
  readonly oddsPct?: number | undefined;
  readonly rationale?: Record<string, unknown> | undefined;
}

const VERDICT_BADGE: Record<CdsVerdict, { label: string; tone: string }> = {
  accept: { label: 'Accept', tone: 'bg-emerald-100 text-emerald-800' },
  caution: { label: 'Caution', tone: 'bg-amber-100 text-amber-800' },
  reject: { label: 'Likely not supportable', tone: 'bg-rose-100 text-rose-800' },
  not_yet_run: { label: 'Not yet run', tone: 'bg-slate-100 text-slate-700' },
};

function asCdsResult(rationale: Record<string, unknown> | undefined): CdsResult | null {
  if (!rationale || typeof rationale !== 'object') return null;
  const r = rationale as Partial<CdsResult>;
  if (!r.verdict || !r.summary || !r.bva || !r.hardGate || !r.checkedAt) return null;
  return r as CdsResult;
}

export function CdsPanel({ caseId, verdict, oddsPct, rationale }: CdsPanelProps) {
  const qc = useQueryClient();
  const result = asCdsResult(rationale);
  const badge = VERDICT_BADGE[verdict];

  const runMut = useMutation({
    mutationFn: () => runCds(caseId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['case', caseId] }),
  });

  const buttonLabel = verdict === 'not_yet_run' ? 'Run CDS' : 'Re-run CDS';
  const oddsDisplay = typeof oddsPct === 'number' ? `${Math.round(oddsPct)}%` : null;

  return (
    <Card className="border-slate-300">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-slate-800">Clinical Decision Support</h2>
            <span className={clsx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', badge.tone)}>
              {badge.label}
            </span>
          </div>

          {verdict === 'not_yet_run' ? (
            <p className="text-sm text-slate-500">
              CDS has not been run for this case yet. The engine checks hard gates (no diagnosis, secondary with no SC anchor, barred theories) and looks up BVA pair odds.
            </p>
          ) : result ? (
            <div className="space-y-2">
              {oddsDisplay ? (
                <div>
                  <div className="text-3xl font-semibold text-slate-900">
                    {oddsDisplay} <span className="text-base font-normal text-slate-500">IMO win rate</span>
                  </div>
                  {result.bva.matched && result.bva.upstream && result.bva.claimed ? (
                    <div className="text-xs text-slate-500">
                      BVA: {result.bva.upstream} → {result.bva.claimed}
                      {typeof result.bva.n === 'number' ? `, n=${result.bva.n}` : ''}
                      {result.bva.tier ? `, tier ${result.bva.tier}` : ''}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-slate-500">No BVA pair data — refer to clinical review.</p>
              )}

              <p className="text-sm text-slate-700">{result.summary}</p>

              {result.hardGate.triggered ? (
                <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                  <div className="font-semibold">{result.hardGate.rule ?? 'Hard gate triggered'}</div>
                  {result.hardGate.detail ? <div className="mt-1 text-rose-700">{result.hardGate.detail}</div> : null}
                </div>
              ) : null}

              {verdict === 'reject' ? (
                <p className="text-xs italic text-slate-500">
                  Recommendation — confirm before any veteran-facing action.
                </p>
              ) : null}

              <p className="text-xs text-slate-400">
                Checked {formatRelativeTime(result.checkedAt)} · engine {result.engineVersion}
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-500">CDS rationale unavailable.</p>
          )}

          {runMut.isError ? (
            <p className="text-sm text-rose-600">CDS run failed. Please retry.</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-start">
          <Button onClick={() => runMut.mutate()} loading={runMut.isPending} variant="secondary">
            {buttonLabel}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function CdsPanelForCase({ c }: { readonly c: CaseDetail }) {
  return (
    <CdsPanel
      caseId={c.id}
      verdict={c.cdsVerdict}
      oddsPct={c.cdsOddsPct}
      rationale={c.cdsRationale}
    />
  );
}
