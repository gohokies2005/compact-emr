import type { Grade } from '../../types/prisma';
import { StatusChip, type ChipTone } from './StatusChip';

// Grade → Aegis tone. A/B = good, C = warn, D/F = bad, unknown/ungraded = neutral. Replaces the
// ad-hoc emerald/blue/slate pairs; the StatusChip carries the shared shape + palette.
function gradeTone(grade: string | null | undefined): ChipTone {
  if (!grade) return 'neutral';
  const head = grade[0]?.toUpperCase();
  if (head === 'A' || head === 'B') return 'good';
  if (head === 'C') return 'warn';
  if (head === 'D' || head === 'F') return 'bad';
  return 'neutral';
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
    <StatusChip tone={gradeTone(grade)} className="px-2.5 py-1">
      Grade: {grade ?? 'Not graded'}
    </StatusChip>
  );
}
