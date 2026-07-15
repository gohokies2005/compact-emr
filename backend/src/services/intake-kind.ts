// Classify a Jotform intake submission as stage-1 (a NEW veteran/claim), stage-2 (a condition/records
// follow-up that carries Stage-1 demographics), or additional_docs (more records for an existing claim).
//
// VENDORED LOGIC — keep in sync with frontend/src/api/intakes.ts `intakeKind`. (The two repos build
// separately; this is the backend copy so the dashboard's "new intakes today" count classifies the
// SAME way the intake-pool UI labels rows.) Title-first (robust to cloned/unknown form IDs), then the
// known-form-ID map, then a stage-2 default for unknown condition forms.
//
// WHY THE DASHBOARD NEEDS THIS (Ryan 2026-06-16): "new intakes today" was a raw COUNT of every Intake
// row created today, so a returning veteran who submits BOTH a stage-1 AND a stage-2 form counted
// twice. "New intakes" should mean new stage-1 submissions only.

export type IntakeKind = 'stage1' | 'additional_docs' | 'stage2';

// Known LIVE form IDs (CLAUDE.md "LIVE Form IDs", verified 2026-06-07) plus historical ones. The
// title match below takes precedence; this map is the fallback when the title is blank/ambiguous.
const KNOWN_FORMS: Record<string, IntakeKind> = {
  '261180463266153': 'stage1',        // First-time intake (LIVE)
  '261928293758069': 'stage1',        // FB Fast-Track intake (LIVE) — title doesn't match the stage-1 regex, ID map is load-bearing
  '261495407772061': 'stage1',        // Returning-client no-fee intake (LIVE)
  '260898029223159': 'stage1',        // Old main Stage-1 intake (DISABLED, historical rows)
  '261178428720156': 'stage2',        // Stage-2 master (LIVE)
  '261483559233058': 'stage2',        // Stage-2 condition form (carries Stage-1 demographics)
  '260804641700146': 'additional_docs', // Additional Records upload (LIVE)
};

export function intakeKind(formId: string | null | undefined, formTitle?: string | null): IntakeKind {
  const t = (formTitle ?? '').toLowerCase();
  if (/additional|more record|supporting doc|upload (more|additional)/.test(t)) return 'additional_docs';
  if (/stage\s*1|new (client|patient|veteran)|initial intake|get started|returning/.test(t)) return 'stage1';
  if (/stage\s*2/.test(t)) return 'stage2';
  const id = formId ?? '';
  if (KNOWN_FORMS[id]) return KNOWN_FORMS[id]!;
  return 'stage2'; // unknown condition forms: treat as a follow-up, not a new intake
}

export function isStage1(formId: string | null | undefined, formTitle?: string | null): boolean {
  return intakeKind(formId, formTitle) === 'stage1';
}
