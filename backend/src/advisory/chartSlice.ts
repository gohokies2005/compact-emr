// The minimal chart slice for the advisory ask-path.
//
// Pulls ONLY the clinical picture the AI needs — the claim, the service-connected conditions of record,
// the active problem list, and active medications — NOT the full extracted document text. Read-only by
// code (a fixed narrow SELECT, never model-influenced), then PHI-redacted before it reaches the model,
// then discarded (never embedded into the index). (Hardening follow-up: pull this through the advisory_ro
// identity via granted chart-slice views — architect gap #2; v1 reads it as a fixed app-role SELECT.)

import type { AppDb } from '../services/db-types.js';
import { redactPhi } from './phiRedactor.js';

export interface ChartSliceData {
  claimType: string | null;
  claimedCondition: string;
  claimedConditions: string[];
  upstreamScCondition: string | null;
  scConditions: Array<{ condition: string; status: string; ratingPct: number | null; dcCode: string | null }>;
  activeProblems: Array<{ problem: string; icd10: string | null; notes: string | null }>;
  activeMedications: Array<{ drugName: string; indication: string | null }>;
}

export interface ChartSlice {
  found: boolean;
  text: string; // redacted, compact — for the model prompt
  claimedCondition: string;
  conditions: string[]; // claimed + clustered + SC anchors — feeds retrieve()'s caseConditions
}

// Compact, human-readable slice + the condition list for retrieval. PURE (caller redacts). Kept minimal:
// no demographics, no SSN/DOB, no full chart text.
export function formatChartSlice(d: ChartSliceData): { text: string; conditions: string[] } {
  const lines: string[] = [];
  lines.push(`Claim: ${d.claimedCondition}${d.claimType ? ` (${d.claimType})` : ''}`);
  if (d.claimedConditions.length > 1) lines.push(`Clustered conditions: ${d.claimedConditions.join('; ')}`);
  if (d.upstreamScCondition) lines.push(`Stated upstream SC condition: ${d.upstreamScCondition}`);
  lines.push('');
  lines.push('Service-connected conditions of record:');
  if (d.scConditions.length === 0) lines.push('  (none recorded)');
  for (const s of d.scConditions) {
    lines.push(`  - ${s.condition}${s.ratingPct != null ? ` (${s.ratingPct}%)` : ''}${s.dcCode ? ` [DC ${s.dcCode}]` : ''} — ${s.status}`);
  }
  lines.push('');
  lines.push('Active problem list:');
  if (d.activeProblems.length === 0) lines.push('  (none recorded)');
  for (const p of d.activeProblems) {
    lines.push(`  - ${p.problem}${p.icd10 ? ` [${p.icd10}]` : ''}${p.notes ? `: ${p.notes}` : ''}`);
  }
  if (d.activeMedications.length > 0) {
    lines.push('');
    lines.push('Active medications:');
    for (const m of d.activeMedications) lines.push(`  - ${m.drugName}${m.indication ? ` (for ${m.indication})` : ''}`);
  }
  const conditions = Array.from(
    new Set(
      [
        d.claimedCondition,
        ...d.claimedConditions,
        ...(d.upstreamScCondition ? [d.upstreamScCondition] : []),
        ...d.scConditions.map((s) => s.condition),
      ]
        .map((c) => (c ?? '').trim())
        .filter((c) => c.length > 0),
    ),
  );
  return { text: lines.join('\n'), conditions };
}

interface ChartSliceRaw {
  claimType: string | null;
  claimedCondition: string;
  claimedConditions: string[] | null;
  upstreamScCondition: string | null;
  veteran: {
    scConditions: Array<{ condition: string; status: string; ratingPct: number | null; dcCode: string | null }>;
    activeProblems: Array<{ problem: string; icd10: string | null; notes: string | null }>;
    activeMedications: Array<{ drugName: string; indication: string | null }>;
  } | null;
}

export async function buildChartSlice(db: AppDb, caseId: string): Promise<ChartSlice | null> {
  const c = (await db.case.findFirst({
    where: { id: caseId },
    select: {
      claimType: true,
      claimedCondition: true,
      claimedConditions: true,
      upstreamScCondition: true,
      veteran: {
        select: {
          scConditions: { select: { condition: true, status: true, ratingPct: true, dcCode: true } },
          activeProblems: { select: { problem: true, icd10: true, notes: true } },
          activeMedications: { select: { drugName: true, indication: true } },
        },
      },
    },
  })) as ChartSliceRaw | null;
  if (c === null) return null;
  const data: ChartSliceData = {
    claimType: c.claimType,
    claimedCondition: c.claimedCondition,
    claimedConditions: c.claimedConditions ?? [],
    upstreamScCondition: c.upstreamScCondition,
    scConditions: c.veteran?.scConditions ?? [],
    activeProblems: c.veteran?.activeProblems ?? [],
    activeMedications: c.veteran?.activeMedications ?? [],
  };
  const { text, conditions } = formatChartSlice(data);
  return { found: true, text: redactPhi(text), claimedCondition: c.claimedCondition, conditions };
}
