import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { getChartReadiness } from '../api/chart-readiness';
import { viewDocument } from '../api/veterans';
import { postDraft } from '../api/drafter';
import { documentFileName } from '../lib/documentFileName';
import type { CaseStatus } from '../types/prisma';

/**
 * LAST-RESORT recovery banner (ADDITION B of the document auto-recovery loop, 2026-06-14).
 *
 * The RN clicks "Send to Drafter" once and walks away; the system auto-recovers from document-read
 * failures with NO human action (remediate-on-upload, auto-skip empty files, the describe rung, and the
 * bounded auto-remediate-on-draft). When ALL of that is exhausted — a file genuinely cannot be read and
 * there is no override — a human is the true last resort. This is that ONE obvious spot: a single
 * persistent banner pinned in the case-page header area (NOT scattered across tabs), with a plain-language
 * directive and clear actions: [Override & draft] / [View file] / [Clear]. No gate codes.
 *
 * It renders ONLY when:
 *   • the case is in a PRE-DRAFT status (the only place unread-file blocking matters), AND
 *   • the chart has SETTLED (extraction not still building — we don't nag mid-build), AND
 *   • there are blocking files (a real unread record with no manual summary), AND
 *   • the staff member hasn't dismissed it this session.
 * Auto-skipped (empty) files are non-blocking and never appear here. The SendToDrafter panel still hosts
 * the inline manual-summary + override flow on the Overview tab; this banner is the always-visible escape
 * hatch so a parked case is never an invisible dead-end on a non-Overview tab.
 */

const PRE_DRAFT_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  'intake', 'records', 'viability', 'drafting',
]);

interface ChartRecoveryBannerProps {
  readonly caseId: string;
  readonly status: CaseStatus;
  // A draft requires both reviewers assigned (same gate as SendToDrafter). When either is missing the
  // override would 400, so we point at Assignments instead of offering a doomed Override button.
  readonly canDraft: boolean;
}

export function ChartRecoveryBanner({ caseId, status, canDraft }: ChartRecoveryBannerProps) {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [reason, setReason] = useState('');

  const isPreDraft = PRE_DRAFT_STATUSES.has(status);

  const readinessQuery = useQuery({
    queryKey: ['case', caseId, 'chart-readiness'],
    queryFn: () => getChartReadiness(caseId),
    enabled: caseId.length > 0 && isPreDraft && !dismissed,
    // Mirror the SendToDrafter poll so the banner clears itself the moment a remediation/manual summary
    // resolves the blockers — no manual refresh.
    refetchInterval: (q) => {
      const st = q.state.data?.data?.extractionState;
      return st === 'extracting' || st === 'ocr_in_progress' ? 8000 : false;
    },
  });

  const draftMutation = useMutation({
    mutationFn: () => postDraft(caseId, { acknowledgeMissingDocs: true, overrideReason: reason.trim() }),
    onSuccess: async () => {
      setOverrideOpen(false);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['case', caseId] });
    },
  });

  const readiness = readinessQuery.data?.data;
  const extractionState = readiness?.extractionState;
  const stillBuilding = extractionState === 'extracting' || extractionState === 'ocr_in_progress';
  const blockingFiles = readiness?.blockingFiles ?? readiness?.blockers ?? [];
  // FIX 3 (2026-06-14): the banner is the LAST resort — it must appear ONLY when auto-recovery has
  // actually given up (the backend's bounded auto-remediate ran for THIS doc-set and the chart is still
  // blocked). Showing it during a normal preparing/extracting cycle papered over the auto-resume stall
  // and nagged the RN mid-build. The backend computes `autoRecoveryExhausted` from the same
  // (caseId, triggerHash) `case_auto_remediated` marker the /draft route checks — single source of truth.
  const autoRecoveryExhausted = readiness?.autoRecoveryExhausted === true;

  // Render only the genuine last-resort state: pre-draft, chart settled, real blockers remain, AND
  // auto-recovery is exhausted, and not dismissed. NOT during a build, and NOT before the first
  // auto-remediation attempt (the SendToDrafter panel's auto-resume handles that window).
  if (dismissed || !isPreDraft || readiness === undefined || stillBuilding || blockingFiles.length === 0 || !autoRecoveryExhausted) {
    return null;
  }

  const first = blockingFiles[0];
  const firstDocId = first?.documentId ?? first?.id ?? null;
  const count = blockingFiles.length;

  async function openFirstFile() {
    if (firstDocId == null) return;
    try {
      const res = await viewDocument(firstDocId);
      window.open(res.data.downloadUrl, '_blank', 'noopener,noreferrer');
    } catch {
      window.alert('Could not open the file for viewing. Try the chart Documents tab.');
    }
  }

  return (
    <div className="rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 px-5 py-4 text-sm text-amber-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <p className="font-semibold">
            {count === 1
              ? 'A document couldn’t be read and needs you'
              : `${count} documents couldn’t be read and need you`}
          </p>
          <p className="mt-1 text-amber-800">
            We tried to read {count === 1 ? 'this file' : 'these files'} automatically and rebuild the chart, but {count === 1 ? 'it' : 'they'} still can’t be read.
            {first ? <> The file is <span className="font-medium">{documentFileName(first.filePath)}</span>.</> : null}{' '}
            Add a brief summary of what {count === 1 ? 'it' : 'they'} show (on the <span className="font-medium">Overview</span> tab), open {count === 1 ? 'it' : 'them'} to check, or draft without {count === 1 ? 'it' : 'them'}.
          </p>
          {!canDraft ? (
            <p className="mt-2 font-medium text-amber-700">Assign a physician and an RN liaison first (Assignments, on the Overview tab) before you can draft.</p>
          ) : null}
        </div>
        <div className="flex flex-none items-center gap-2">
          {firstDocId != null ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => void openFirstFile()}>View file</Button>
          ) : null}
          {canDraft && !overrideOpen ? (
            <Button type="button" variant="secondary" size="sm" className="border border-amber-300 bg-white text-amber-900 hover:bg-amber-100" onClick={() => setOverrideOpen(true)}>
              Override &amp; draft
            </Button>
          ) : null}
          <Button type="button" variant="secondary" size="sm" onClick={() => setDismissed(true)}>Clear</Button>
        </div>
      </div>
      {overrideOpen ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-white p-3">
          <label className="block">
            <span className="text-sm font-medium text-amber-900">
              Briefly describe what the unread file(s) show so it’s logged on the case (the drafter will run without the file itself).
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
              placeholder="What does the file show?"
            />
          </label>
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setOverrideOpen(false)}>Cancel</Button>
            <Button type="button" variant="primary" size="sm" disabled={reason.trim().length === 0} loading={draftMutation.isPending} onClick={() => draftMutation.mutate()}>
              Override and start draft
            </Button>
          </div>
          {draftMutation.isError ? (
            <p className="mt-2 text-sm text-rose-700">Could not start the draft. Please retry.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
