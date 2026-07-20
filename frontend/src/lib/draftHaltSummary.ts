// Plain-language drafter-halt summary for the RN (Ryan 2026-06-24, "no codish errors, give me a checklist +
// a conditional grade + a specific fix"). PURE: turns the already-persisted manifestSnapshot.phases +
// gradeSidecarJson into (a) a conditional grade, (b) an RN-friendly step checklist, (c) the single most
// important next action, and (d) whether the halt is COSMETIC (ship-as-is OK) or SUBSTANTIVE (fix first).
//
// SAFETY RULE (Ryan): a substantive/medical halt must NEVER wear the "all good, ship it" face. Only a
// cosmetic halt (formatting-only, on a ship-grade letter) offers ship-as-is; anything that touched content
// leads with "fix first" and names the issue. The decisive question: did the halt change what the letter
// MEANS, or only how it LOOKS?

export interface ManifestPhaseLike { readonly id?: string; readonly status?: string | null; readonly operator_message?: string | null; readonly summary?: string | null }
export interface ManifestLike { readonly phases?: Record<string, ManifestPhaseLike> | null }
// A revision hint. The persisted shape is { section, issue, suggested_fix } (TargetedRevisionHint); a plain
// string is also accepted for robustness. Both normalize to one readable line.
export type RevisionHintLike = string | { readonly section?: string | null; readonly issue?: string | null; readonly suggested_fix?: string | null };
// Loose superset of the persisted gradeSidecarJson — grade/ship/rationale may be present when the whole grade
// object was persisted; the hints are always TargetedRevisionHint-shaped. All optional + null-tolerant so the
// real DraftGradeSidecarJson is assignable.
export interface GradeSidecarLike {
  readonly grade?: string | null;
  readonly ship_recommendation?: string | null;
  readonly weighted_score?: number | null;
  readonly grade_rationale_plain?: string | null;
  readonly weak_sections?: readonly string[] | null;
  readonly targeted_revision_hints?: readonly RevisionHintLike[];
  readonly synthesized_floor?: boolean | null;
}

export type StepStatus = 'done' | 'stopped' | 'pending';
export interface HaltStep { readonly label: string; readonly status: StepStatus; readonly reason?: string }

export interface DraftHaltSummary {
  readonly grade: string | null;            // e.g. "B+" — null when never graded
  readonly gradeIsFloor: boolean;           // a synthesized floor grade (the run died before the real grader)
  readonly ship: 'ship' | 'revise' | 'unknown';
  readonly rationale: string | null;        // plain-language grade rationale
  readonly steps: readonly HaltStep[];      // the RN-friendly checklist
  readonly stoppedAtLabel: string | null;   // the step where it stopped (null = finished clean)
  readonly cosmetic: boolean;               // true => formatting-only halt on a ship-grade letter => ship-as-is OK
  // The ONE safety gate the UI keys "ready to ship" on. True ONLY when cosmetic, OR the run finished clean (no
  // stopped stage), the grade is real (not a synthesized floor), it recommends ship, and there are no fixes.
  // A substantive halt or a floor grade is ALWAYS false here — it must never wear the all-good face.
  readonly shipAsIs: boolean;
  readonly fixList: readonly string[];      // the specific manual fixes (plain language)
  readonly nextAction: string;              // the single bolded next-action line
}

// The 6 RN-friendly stages, each grouping the underlying pipeline phases. Order = pipeline order.
const STAGES: ReadonlyArray<{ label: string; phases: readonly string[] }> = [
  { label: 'Wrote the draft', phases: ['preflight', 'index_consult', 'framing_gate', 'plan_validity', 'cover_memo', 'source_lock', 'drafter'] },
  { label: 'Specialist review panel', phases: ['adversary_panel', 'specialist_gate'] },
  { label: 'Automatic fixes', phases: ['refine_loop', 'surgical_edit'] },
  { label: 'Quality checks', phases: ['citation_scoring', 'pmid_verify', 'linter'] },
  { label: 'Graded the letter', phases: ['qa_report', 'grader'] },
  { label: 'Final formatting check', phases: ['render', 'render_parity'] },
];

// The phases whose failure is COSMETIC (formatting only — the letter content is unchanged).
const COSMETIC_PHASES = new Set(['render', 'render_parity']);

function normHint(h: RevisionHintLike): string {
  if (typeof h === 'string') return h.trim();
  const issue = typeof h.issue === 'string' ? h.issue.trim() : '';
  const section = typeof h.section === 'string' && h.section.trim() ? `(${h.section.trim()})` : '';
  const fix = typeof h.suggested_fix === 'string' ? h.suggested_fix.trim() : '';
  return [issue, section, fix].filter(Boolean).join(' — ');
}

// grade + ship are read from the persisted gradeSidecarJson, which carries the WHOLE qa_grade object at runtime
// (grade / ship_recommendation / grade_rationale_plain) even though its narrow DB type only declares the hints.
export function buildDraftHaltSummary(
  manifest: ManifestLike | null | undefined,
  grade: GradeSidecarLike | null | undefined,
): DraftHaltSummary {
  const phases = manifest?.phases ?? {};
  const phaseStatus = (id: string): string => (phases[id]?.status ?? '').toLowerCase();

  // Build the checklist. A stage is 'stopped' if ANY of its phases crashed; 'done' if it has a phase that ran
  // (and none crashed); 'pending' if none of its phases reached a terminal status (it was never reached).
  const steps: HaltStep[] = [];
  let stoppedAtLabel: string | null = null;
  let crashedPhaseId: string | null = null;
  let sawStop = false;
  for (const stage of STAGES) {
    const statuses = stage.phases.map(phaseStatus);
    const crashed = stage.phases.find((p, i) => statuses[i] === 'crashed' || statuses[i] === 'failed');
    const anyRan = statuses.some((s) => s === 'ran' || s === 'complete' || s === 'skipped');
    let status: StepStatus;
    if (crashed && !sawStop) {
      status = 'stopped';
      stoppedAtLabel = stage.label;
      crashedPhaseId = crashed;
      sawStop = true;
    } else if (sawStop) {
      status = 'pending'; // everything after the stop never ran
    } else if (anyRan) {
      status = 'done';
    } else {
      status = 'pending';
    }
    steps.push({ label: stage.label, status, ...(status === 'stopped' ? { reason: plainPhaseReason(crashedPhaseId, phases) } : {}) });
  }

  const gradeStr = String(grade?.grade ?? '').trim() || null;
  const shipRaw = grade?.ship_recommendation ?? null;
  const ship: DraftHaltSummary['ship'] = shipRaw === 'ship' ? 'ship' : shipRaw ? 'revise' : 'unknown';
  const fixList = (grade?.targeted_revision_hints ?? []).map(normHint).filter(Boolean);

  // COSMETIC = the only thing that stopped is a formatting phase AND the letter is ship-grade. That is the
  // sole condition under which "ship as-is" is offered. Anything else leads with "fix first".
  const cosmetic = crashedPhaseId !== null && COSMETIC_PHASES.has(crashedPhaseId) && ship === 'ship';
  const gradeIsFloor = grade?.synthesized_floor === true;
  // The single safety gate (see DraftHaltSummary.shipAsIs). A substantive stop or a floor grade is never ship-as-is.
  const shipAsIs = cosmetic || (stoppedAtLabel === null && !gradeIsFloor && ship === 'ship' && fixList.length === 0);

  let nextAction: string;
  if (stoppedAtLabel === null) {
    nextAction = ship === 'ship' ? 'Open the letter, give it a final read, and sign/send.' : 'Review the letter and the fix list below before sending.';
  } else if (cosmetic) {
    nextAction = 'Open the PDF, confirm it reads correctly, and you are clear to sign and send.';
  } else if (fixList.length > 0) {
    nextAction = 'Fix the item(s) below in the editor, then re-render — do NOT send until corrected.';
  } else {
    nextAction = 'Open the letter in the editor and review the flagged step before sending.';
  }

  return {
    grade: gradeStr,
    gradeIsFloor,
    ship,
    rationale: (grade?.grade_rationale_plain ?? '').trim() || null,
    steps,
    stoppedAtLabel,
    cosmetic,
    shipAsIs,
    fixList,
    nextAction,
  };
}

// A plain-language reason for the stopped phase. Prefers the phase's own operator_message/summary; falls
// back to a per-phase plain sentence. NEVER returns a rule_id / stack / code token.
function plainPhaseReason(phaseId: string | null, phases: Record<string, ManifestPhaseLike>): string {
  const p = phaseId ? phases[phaseId] : undefined;
  const msg = (p?.operator_message ?? p?.summary ?? '').trim();
  if (msg && !/threw|exception|stack|rule_id|[{}]|error:/i.test(msg)) return msg;
  switch (phaseId) {
    case 'plan_validity':
      // Fix C (2026-07-19): the Phase 0.5a plan-validity park. General on purpose — it covers any
      // secondary-with-unverified-upstream hold, not one condition. Names the real, actionable step.
      return 'Secondary theory needs the service-connected primary confirmed on file. The named upstream condition is not marked Service-connected (it may be Pending). A rating decision in the chart may grant it — confirm the SC-Conditions status, then re-run.';
    case 'render':
    case 'render_parity':
      return 'A small formatting difference in the PDF (a line-wrap). The letter content is unchanged.';
    case 'pmid_verify':
      return 'A citation could not be verified — confirm it is real or remove it before signing.';
    case 'adversary_panel':
    case 'specialist_gate':
      return 'The automated review panel did not complete — the letter was produced without it.';
    default:
      return 'A step did not complete. The letter it produced is saved and can be reviewed.';
  }
}
