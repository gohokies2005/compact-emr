import type { Grade } from '../../types/prisma';

// Color logic moved here from PhysicianLetterReadyPanel so grade rendering has one source.
function gradeClassName(grade: string | null | undefined): string {
  if (!grade) return 'bg-slate-100 text-slate-700';
  if (grade.startsWith('A')) return 'bg-emerald-100 text-emerald-800';
  if (grade === 'B+' || grade === 'B') return 'bg-blue-100 text-blue-800';
  return 'bg-slate-100 text-slate-700';
}

interface GradeChipProps {
  // `| undefined` is explicit because the project uses exactOptionalPropertyTypes — callers pass
  // optional-chained values (e.g. job?.gradeSidecarJson?.synthesized_floor) that may be undefined.
  readonly grade?: Grade | string | null | undefined;
  // From DraftGradeSidecarJson. When true, the grade is a synthesized floor (the grader could not
  // compute a real probative grade) — show amber "grade unavailable", never the silent letter.
  readonly synthesizedFloor?: boolean | null | undefined;
  readonly reason?: string | null | undefined;
}

/**
 * Single source of truth for grade display. `synthesized_floor` is an untrusted payload from the
 * drafter worker, so we gate strictly on `=== true`. Dormant until the worker emits it: today the
 * field is absent, so this renders byte-identical to the prior grade pill.
 */
export function GradeChip({ grade, synthesizedFloor, reason }: GradeChipProps) {
  if (synthesizedFloor === true) {
    return (
      <span
        className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800"
        title={reason ? reason.slice(0, 200) : 'The grader could not compute a probative grade for this letter; a physician must review it directly.'}
      >
        Grade unavailable — needs review
      </span>
    );
  }
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${gradeClassName(grade)}`}>
      Grade: {grade ?? 'Not graded'}
    </span>
  );
}
