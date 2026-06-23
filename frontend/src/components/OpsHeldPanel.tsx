import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { GradeChip } from './ui/GradeChip';
import { postDraft } from '../api/drafter';
import { transitionCaseStatus, type CaseDetail } from '../api/cases';
import { ConflictError } from '../api/client';
import type { DraftJob } from '../types/prisma';

interface ManifestPhase {
  readonly operator_message?: string | null;
  readonly summary?: string | null;
  readonly status?: string | null;
}

interface ManifestSnapshot {
  readonly phases?: Record<string, ManifestPhase>;
}

interface GradeSidecarJson {
  readonly detail_phase?: string | null;
  readonly synthesized_floor?: boolean | null;
  readonly synthesized_floor_reason?: string | null;
}

export interface OpsDraftJob extends DraftJob {
  readonly manifestSnapshot?: ManifestSnapshot | null;
  readonly gradeSidecarJson?: GradeSidecarJson | null;
}

interface OpsHeldPanelProps {
  readonly c: CaseDetail;
  readonly job?: OpsDraftJob | null;
  readonly isAdmin: boolean;
  // A letter PDF exists for this case (on some draft-job version), so it can be opened even
  // though the run is held/revise. Without this, a non-'ship' letter had no way to be viewed
  // in the chart at all (2026-06-03 — Ryan "could not see the letter drafted anywhere").
  readonly hasLetter?: boolean;
  readonly onViewLetter?: () => void;
  // Open the produced (partial) letter in the FULL EDITOR (2026-06-22). When a draft exists, the
  // primary recovery is to fix it by hand — far cheaper than a ~$15 full re-run — so the lead
  // affordance routes to the editor, NOT the read-only PDF. CaseDetailPage wires this to
  // navigate(`/cases/:id/letter`), the same entry the physician/RN ready panels use.
  readonly onOpenEditor?: () => void;
}

function operatorMessage(c: CaseDetail, job?: OpsDraftJob | null): string {
  // G8: Case.operatorMessage takes precedence if set (populated by /complete or by the
  // stuck-job watcher when it sweeps stale jobs). This is the RN-friendly text.
  if (typeof c.operatorMessage === 'string' && c.operatorMessage.trim().length > 0) {
    return c.operatorMessage;
  }

  if (c.operatorState === 'paused') {
    return "We've paused this one for a closer look. Nothing's lost - your work is saved and we've flagged it for the team.";
  }

  if (c.operatorState === 'needs_one_thing') {
    const detailPhase = job?.gradeSidecarJson?.detail_phase ?? null;
    const phase = detailPhase ? job?.manifestSnapshot?.phases?.[detailPhase] : undefined;
    const message = phase?.operator_message?.trim();

    if (message) return message;
  }

  return 'Drafter completed with concerns.';
}

export function OpsHeldPanel({ c, job, isAdmin, hasLetter, onViewLetter, onOpenEditor }: OpsHeldPanelProps) {
  const qc = useQueryClient();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmOpenAsIs, setConfirmOpenAsIs] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const phases = useMemo(() => Object.entries(job?.manifestSnapshot?.phases ?? {}), [job]);

  const rerunMutation = useMutation({
    mutationFn: () => postDraft(c.id),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['case', c.id] }),
        qc.invalidateQueries({ queryKey: ['case', c.id, 'draft-jobs'] }),
      ]);
    },
    onError: (error: unknown) => {
      setErrorMessage(
        error instanceof ConflictError
          ? 'A drafter run is already in flight for this case.'
          : 'The drafter could not be re-run. Please retry.',
      );
    },
  });

  const openAsIsMutation = useMutation({
    mutationFn: () =>
      transitionCaseStatus(c.id, {
        from: c.status,
        to: 'physician_review',
        version: c.version,
        transitionReason: 'admin override to physician review',
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['case', c.id] });
      setConfirmOpenAsIs(false);
    },
    onError: () => {
      setErrorMessage('The case could not be opened as-is. Please retry.');
    },
  });

  return (
    <Card className="rounded-2xl border border-aegis bg-ivory shadow-aegis-card">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          {/* HONEST headline (2026-06-22): the old hardcoded "Drafting was interrupted" overstated the
              no-letter case (the run may have failed before producing anything) — it read as a vague
              "something broke" with no real cause. The case-specific operatorMessage below carries the
              REAL reason (the failed phase + its recorded note, via summarizeForOperator). */}
          <h2 className="text-base font-semibold text-navyDeep">
            {hasLetter ? 'This draft did not finish — but it produced a letter' : 'This draft did not finish'}
          </h2>
          <p className="mt-1 text-sm text-steel">
            {hasLetter
              ? 'The run stopped before completing, but it produced a letter you can open and finish in the editor — usually faster and cheaper than a full re-run. Re-run only if a fresh draft is genuinely needed.'
              : 'The run stopped and did not produce a letter. Re-run it to draft to completion. The reason is below.'}
          </p>
          <p className="mt-2 text-sm text-steel">{operatorMessage(c, job)}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {/* When a letter WAS produced, the LEAD action is to open + finish it in the editor (the cheap
              path) — re-draft drops to secondary. When no letter exists, re-run is the only path and stays
              primary. (2026-06-22 — repoints the old "Open what it produced" away from the read-only PDF.)
              INTERIM: re-run RE-RUNS THE WHOLE DRAFT from the start (~$15); the confirm says so plainly. */}
          {hasLetter && onOpenEditor ? (
            <Button type="button" variant="primary" onClick={onOpenEditor}>
              Open letter editor
            </Button>
          ) : null}

          <Button
            type="button"
            variant={hasLetter && onOpenEditor ? 'secondary' : 'primary'}
            loading={rerunMutation.isPending}
            disabled={rerunMutation.isPending}
            onClick={() => { if (window.confirm('This re-runs the ENTIRE draft from the start — a full ~$15 run (about 20 minutes). It does NOT yet resume from where it stopped. For a small fix, use the surgical or guided edit on the letter instead. Re-run the full draft?')) rerunMutation.mutate(); }}
          >
            Re-run full draft
          </Button>

          {/* Read-only PDF view kept as a tertiary option (some reviewers prefer to skim the PDF first). */}
          {hasLetter && onViewLetter ? (
            <Button type="button" variant="ghost" onClick={onViewLetter}>
              View PDF
            </Button>
          ) : null}

          {isAdmin ? (
            <Button type="button" variant="ghost" onClick={() => setConfirmOpenAsIs(true)}>
              Open as-is
            </Button>
          ) : null}
        </div>
      </div>

      {errorMessage ? (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      ) : null}

      <button
        type="button"
        className="mt-4 text-sm font-medium text-steel hover:text-navyDeep"
        onClick={() => setDetailsOpen((current) => !current)}
      >
        Details {detailsOpen ? '▴' : '▾'}
      </button>

      {detailsOpen ? (
        <div className="mt-4 rounded-2xl border border-aegis bg-mistSoft p-4">
          <div className="grid gap-2 text-sm text-steel sm:grid-cols-3">
            <div><GradeChip grade={c.grade} synthesizedFloor={job?.gradeSidecarJson?.synthesized_floor} reason={job?.gradeSidecarJson?.synthesized_floor_reason} /></div>
            <div>Ship recommendation: {c.shipRecommendation ?? 'Unknown'}</div>
            <div>Operator state: {c.operatorState ?? 'Unknown'}</div>
          </div>

          {phases.length > 0 ? (
            <div className="mt-4 space-y-2">
              {phases.map(([phaseId, phase]) => (
                <div key={phaseId} className="rounded-xl bg-ivory p-3 text-sm text-steel">
                  <span className="font-medium">{phase.summary ?? phase.status ?? 'Phase complete'}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {confirmOpenAsIs ? (
        <div role="dialog" aria-modal="true" aria-labelledby="open-as-is-title">
          <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" />
          <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-2xl">
            <h3 id="open-as-is-title" className="text-lg font-semibold text-slate-900">
              Open as-is
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              This moves the case to physician review despite the ops hold. Use only when an
              operator has judged the letter acceptable.
            </p>

            <div className="mt-6 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={openAsIsMutation.isPending}
                onClick={() => setConfirmOpenAsIs(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={openAsIsMutation.isPending}
                disabled={openAsIsMutation.isPending}
                onClick={() => openAsIsMutation.mutate()}
              >
                Confirm open as-is
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
