import { useState } from 'react';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { GradeChip } from './ui/GradeChip';
import { SendBackToRnModal } from './SendBackToRnModal';
import type { CaseDetail } from '../api/cases';
import type { DraftJob, TargetedRevisionHint, TemplateGateFinding, DraftGradeSidecarJson } from '../types/prisma';

export interface ReadyDraftJob extends DraftJob {
  readonly artifactPdfS3Key?: string | null;
  readonly gradeSidecarJson?: DraftGradeSidecarJson | null;
}

interface PhysicianLetterReadyPanelProps {
  readonly c: CaseDetail;
  readonly job: ReadyDraftJob;
  readonly canSendBack: boolean;
  readonly onOpenPdf: (s3Key: string) => void | Promise<void>;
  readonly onEditText?: () => void;
  readonly onOpenSignOff: () => void;
  readonly onChanged: () => void | Promise<void>;
}

function truncate(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}...`;
}

function normalizedHints(job: ReadyDraftJob): readonly TargetedRevisionHint[] {
  const hints = job.gradeSidecarJson?.targeted_revision_hints ?? [];
  return hints
    .filter((hint) => typeof hint.issue === 'string' && hint.issue.trim().length > 0)
    .slice(0, 3);
}

// Anchor/template-quality findings the physician must confirm or fix at sign-off. Audit-only
// findings are excluded (audit trail, not physician action). gradeSidecarJson is an untrusted
// worker payload persisted wholesale, so guard the shape hard: a non-array or a null/non-object
// element must NOT throw inside this render (it backs the Approve-and-sign screen). Cap at 5 so a
// runaway payload can't bury the sign button under a wall of amber.
function normalizedGateFindings(job: ReadyDraftJob): readonly TemplateGateFinding[] {
  const raw = job.gradeSidecarJson?.template_gate_findings;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is TemplateGateFinding =>
      f != null && typeof f === 'object' &&
      f.audit_only !== true &&
      typeof f.message === 'string' && f.message.trim().length > 0)
    .slice(0, 5);
}

export function PhysicianLetterReadyPanel({
  c,
  job,
  canSendBack,
  onOpenPdf,
  onEditText,
  onOpenSignOff,
  onChanged,
}: PhysicianLetterReadyPanelProps) {
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const grade = c.grade ?? null;
  const score = c.probativeScore ?? null;
  const hints = normalizedHints(job);
  const gateFindings = normalizedGateFindings(job);
  const pdfKey = job.artifactPdfS3Key ?? null;

  return (
    <Card className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Letter is ready for your review
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <GradeChip grade={grade} synthesizedFloor={job.gradeSidecarJson?.synthesized_floor} reason={job.gradeSidecarJson?.synthesized_floor_reason} />
            <span>
              Probative score: {typeof score === 'number' ? `${score}/10` : 'Not scored'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={!pdfKey}
            onClick={() => {
              if (pdfKey) void onOpenPdf(pdfKey);
            }}
          >
            Open PDF
          </Button>
          <Button type="button" variant="secondary" disabled={!onEditText} title={onEditText ? undefined : 'Coming soon'} onClick={onEditText}>
            Edit text
          </Button>
          <Button type="button" variant="primary" onClick={onOpenSignOff}>
            Approve and sign
          </Button>
        </div>
      </div>

      {gateFindings.length > 0 ? (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-semibold text-amber-900">
            Anchor and template quality - physician review (overridable)
          </h3>
          <p className="mt-1 text-xs text-amber-800">
            The letter's template binding or epidemiologic anchor needs a look. Confirm or fix before signing.
          </p>
          <ul className="mt-3 space-y-2">
            {gateFindings.map((finding, index) => (
              <li key={`${finding.id ?? 'finding'}-${index}`} className="text-sm text-amber-900">
                <span className="text-amber-500">{'• '}</span>
                {finding.severity === 'critical' ? <span className="mr-1 rounded bg-amber-200 px-1.5 py-0.5 text-xs font-semibold text-amber-900">critical</span> : null}
                <span>{truncate(finding.message ?? '', 200)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {hints.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-slate-800">
            {hints.length} {hints.length === 1 ? 'thing' : 'things'} the system chose for you on
            close calls:
          </h3>
          <ul className="mt-3 space-y-2">
            {hints.map((hint, index) => (
              <li key={`${hint.section ?? 'section'}-${index}`} className="text-sm text-slate-700">
                <span className="text-slate-400">{'• '}</span>
                <span className="font-medium">Section {hint.section ?? 'review'} - </span>
                <span>{hint.issue ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canSendBack ? (
        <div className="mt-6 flex justify-end border-t border-slate-200 pt-4">
          <Button type="button" variant="ghost" onClick={() => setSendBackOpen(true)}>
            Send back to RN
          </Button>
        </div>
      ) : null}

      <SendBackToRnModal
        caseId={c.id}
        veteranId={c.veteranId}
        from={c.status}
        version={c.version}
        open={sendBackOpen}
        onClose={() => setSendBackOpen(false)}
        onDone={onChanged}
      />
    </Card>
  );
}
