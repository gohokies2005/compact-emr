import { useState } from 'react';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { SendBackToRnModal } from './SendBackToRnModal';
import type { CaseDetail } from '../api/cases';
import type { DraftJob } from '../types/prisma';

interface TargetedRevisionHint {
  readonly section?: string | null;
  readonly issue?: string | null;
  readonly suggested_fix?: string | null;
}

interface GradeSidecarJson {
  readonly targeted_revision_hints?: readonly TargetedRevisionHint[];
}

export interface ReadyDraftJob extends DraftJob {
  readonly artifactPdfS3Key?: string | null;
  readonly gradeSidecarJson?: GradeSidecarJson | null;
}

interface PhysicianLetterReadyPanelProps {
  readonly c: CaseDetail;
  readonly job: ReadyDraftJob;
  readonly canSendBack: boolean;
  readonly onOpenPdf: (s3Key: string) => void | Promise<void>;
  readonly onOpenSignOff: () => void;
  readonly onChanged: () => void | Promise<void>;
}

function gradeClassName(grade: string | null | undefined): string {
  if (!grade) return 'bg-slate-100 text-slate-700';
  if (grade.startsWith('A')) return 'bg-emerald-100 text-emerald-800';
  if (grade === 'B+' || grade === 'B') return 'bg-blue-100 text-blue-800';
  return 'bg-slate-100 text-slate-700';
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

export function PhysicianLetterReadyPanel({
  c,
  job,
  canSendBack,
  onOpenPdf,
  onOpenSignOff,
  onChanged,
}: PhysicianLetterReadyPanelProps) {
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const grade = c.grade ?? null;
  const score = c.probativeScore ?? null;
  const hints = normalizedHints(job);
  const pdfKey = job.artifactPdfS3Key ?? null;

  return (
    <Card className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Letter is ready for your review
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${gradeClassName(grade)}`}>
              Grade: {grade ?? 'Not graded'}
            </span>
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
          <Button type="button" variant="secondary" disabled title="Coming soon">
            Edit text
          </Button>
          <Button type="button" variant="primary" onClick={onOpenSignOff}>
            Approve and sign
          </Button>
        </div>
      </div>

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
                <span>{truncate(hint.issue ?? '')}</span>
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
