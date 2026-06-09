import { useState } from 'react';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { GradeChip } from './ui/GradeChip';
import { SendBackToRnModal } from './SendBackToRnModal';
import type { CaseDetail } from '../api/cases';
import type { DraftJob, TargetedRevisionHint, DraftGradeSidecarJson } from '../types/prisma';

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
  // Physician mode: the primary action signs off (onOpenSignOff). RN mode: the primary action
  // sends the letter to the doctor (onSendToDoctor) — supplied for status='rn_review' so the RN
  // reviews/edits first, then explicitly sends. Exactly one is expected per render.
  readonly onOpenSignOff?: () => void;
  readonly onSendToDoctor?: () => void;
  // When set, "Send to doctor" is disabled and shows this reason (e.g. no physician assigned yet).
  readonly sendToDoctorBlockedReason?: string | undefined;
  readonly sending?: boolean;
  readonly onChanged: () => void | Promise<void>;
}

// The top things the physician should consider — shown IN FULL (no truncation). gradeSidecarJson
// is an untrusted worker payload persisted wholesale, so guard the shape and drop blank issues.
// Capped at 3: Ryan wants exactly the grade + the top 3 considerations on this panel, nothing more
// (2026-06-04 — "just the top 3 things to consider is all I want for now ... not truncated text").
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
  onEditText,
  onOpenSignOff,
  onSendToDoctor,
  sendToDoctorBlockedReason,
  sending,
  onChanged,
}: PhysicianLetterReadyPanelProps) {
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const grade = c.grade ?? null;
  const score = c.probativeScore ?? null;
  const hints = normalizedHints(job);
  const pdfKey = job.artifactPdfS3Key ?? null;

  return (
    <Card className="rounded-2xl border border-aegis bg-ivory shadow-aegis-card">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-navyDeep">
            {onSendToDoctor ? 'Review the letter, then send to the doctor' : 'Letter is ready for your review'}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-steel">
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
          {onSendToDoctor ? (
            <div className="flex flex-col items-end gap-1">
              <Button type="button" variant="primary" loading={sending ?? false} disabled={(sending ?? false) || !!sendToDoctorBlockedReason} title={sendToDoctorBlockedReason} onClick={onSendToDoctor}>
                Send to doctor for review
              </Button>
              {sendToDoctorBlockedReason ? <span className="text-xs text-amber-700">{sendToDoctorBlockedReason}</span> : null}
            </div>
          ) : onOpenSignOff ? (
            <Button type="button" variant="primary" onClick={onOpenSignOff}>
              Approve and sign
            </Button>
          ) : null}
        </div>
      </div>

      {hints.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-navyDeep">
            Top {hints.length === 1 ? 'thing' : `${hints.length} things`} to consider:
          </h3>
          <ul className="mt-3 space-y-2">
            {hints.map((hint, index) => (
              <li key={`${hint.section ?? 'section'}-${index}`} className="text-sm text-steel">
                <span className="text-slate-400">{'• '}</span>
                <span className="font-medium">Section {hint.section ?? 'review'} — </span>
                {/* Shown in full — never truncated (Ryan 2026-06-04). */}
                <span className="whitespace-pre-wrap">{hint.issue ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canSendBack ? (
        <div className="mt-6 flex justify-end border-t border-aegis pt-4">
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
