// The minimal chart slice for the advisory ask-path.
//
// Pulls ONLY the clinical picture the AI needs — the claim, the service-connected conditions of record,
// the active problem list, and active medications — NOT the full extracted document text. Read-only by
// code (a fixed narrow SELECT, never model-influenced), then PHI-redacted before it reaches the model,
// then discarded (never embedded into the index). (Hardening follow-up: pull this through the advisory_ro
// identity via granted chart-slice views — architect gap #2; v1 reads it as a fixed app-role SELECT.)

import type { AppDb } from '../services/db-types.js';
import { redactPhi } from './phiRedactor.js';
import { listVeteranCorrespondence } from '../services/gmail-readonly.js';
import { deriveCaseFramingForCase } from '../services/case-framing-stamp.js';
import { reconcileScConditions } from '../services/sc-reconcile.js';
import type { CaseFraming } from '../services/case-framing.js';
import {
  buildDocumentDigest,
  type DigestDocInput,
  type DigestPageInput,
} from './documentDigest.js';

export interface ChartSliceData {
  claimType: string | null;
  claimedCondition: string;
  claimedConditions: string[];
  upstreamScCondition: string | null;
  scConditions: Array<{ condition: string; status: string; ratingPct: number | null; dcCode: string | null }>;
  activeProblems: Array<{ problem: string; icd10: string | null; notes: string | null }>;
  activeMedications: Array<{ drugName: string; indication: string | null }>;
  // The narrative + framing the chart slice was previously blind to. veteranStatement + inServiceEvent
  // are veteran-supplied free text; caseFraming is the derived SSOT framing object. documentDigest is the
  // freshness manifest + high-signal extracted-text digest of the case's uploads. All three are rendered
  // INSIDE the same untrusted-data fence as the rest of the slice (the assembler wraps the whole text).
  veteranStatement: string | null;
  inServiceEvent: string | null;
  caseFraming: CaseFraming | null;
  documentDigest: string | null;
  // The case/veteran email thread (our team ↔ veteran), most-recent window, pulled from LIVE Gmail —
  // the SAME source the EMR Email tab renders (gmail-readonly), so Ask Aegis sees what staff see. Lets
  // it answer "what did I email him?". Rendered inside the same untrusted-data fence + PHI-redacted with
  // the rest of the slice. (Ryan 2026-06-16: was reading the Email table, which the tab does NOT show.)
  emailThread: string | null;
  // Staff Notes (ChartNote, veteran-scoped) + internal staff Messages on this case (CaseMessage). Ask
  // Aegis should see EVERYTHING in the chart (Ryan 2026-06-16) — the drafter does NOT get these.
  staffNotes: string | null;
  staffMessages: string | null;
}

export interface ChartSlice {
  found: boolean;
  text: string; // redacted, compact — for the model prompt
  claimedCondition: string;
  conditions: string[]; // claimed + clustered + SC anchors — feeds retrieve()'s caseConditions
}

// Collapse whitespace + cap a free-text field for the slice (lay statement / in-service event). Returns
// '' for null/blank so the caller can skip the section entirely.
function oneLine(s: string | null | undefined, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length === 0) return '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
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
    const conflict = (s as { statusConflict?: boolean }).statusConflict ? ' (CONFLICTING status on file — service-connected AND denied; verify before relying on it)' : '';
    lines.push(`  - ${s.condition}${s.ratingPct != null ? ` (${s.ratingPct}%)` : ''}${s.dcCode ? ` [DC ${s.dcCode}]` : ''} — ${s.status}${conflict}`);
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

  // Narrative + framing (previously absent — Ask Aegis was blind to these). Cap the free-text fields so
  // a long lay statement can't blow the slice budget; the document digest carries its own caps.
  const vetStmt = oneLine(d.veteranStatement, 1200);
  const inSvc = oneLine(d.inServiceEvent, 600);
  if (vetStmt) {
    lines.push('');
    lines.push("Veteran's statement (lay narrative):");
    lines.push(`  ${vetStmt}`);
  }
  if (inSvc) {
    lines.push('');
    lines.push('Stated in-service event/exposure:');
    lines.push(`  ${inSvc}`);
  }
  if (d.caseFraming) {
    lines.push('');
    lines.push('Case framing (system-derived):');
    lines.push(`  theory: ${d.caseFraming.framing}; claimType: ${d.caseFraming.claimType}; source: ${d.caseFraming.source}`);
    if (d.caseFraming.upstreamScCondition) lines.push(`  upstream SC condition: ${d.caseFraming.upstreamScCondition}`);
    if (d.caseFraming.framingChoice) lines.push(`  RN framing choice: ${d.caseFraming.framingChoice}`);
    if (d.caseFraming.grantedScAnchors.length > 0) {
      lines.push(`  granted SC anchors: ${d.caseFraming.grantedScAnchors.map((a) => `${a.condition}${a.ratingPct != null ? ` (${a.ratingPct}%)` : ''}`).join('; ')}`);
    }
  }
  if (d.documentDigest && d.documentDigest.trim().length > 0) {
    lines.push('');
    lines.push(d.documentDigest);
  }
  // Communication + internal record (Ask Aegis sees the whole chart; the drafter never gets these).
  if (d.emailThread && d.emailThread.trim().length > 0) {
    lines.push('');
    lines.push('Email correspondence (our team ↔ veteran, most recent first window):');
    lines.push(d.emailThread);
  }
  if (d.staffNotes && d.staffNotes.trim().length > 0) {
    lines.push('');
    lines.push('Staff notes (internal, chart-level):');
    lines.push(d.staffNotes);
  }
  if (d.staffMessages && d.staffMessages.trim().length > 0) {
    lines.push('');
    lines.push('Internal staff messages on this case:');
    lines.push(d.staffMessages);
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
  veteranId: string | null;
  veteranStatement: string | null;
  inServiceEvent: string | null;
  veteran: {
    email: string | null;
    scConditions: Array<{ condition: string; status: string; ratingPct: number | null; dcCode: string | null }>;
    activeProblems: Array<{ problem: string; icd10: string | null; notes: string | null }>;
    activeMedications: Array<{ drugName: string; indication: string | null }>;
  } | null;
}

// Read the case's uploaded documents + their per-page OCR text and build the freshness manifest +
// high-signal extracted digest. LIVE-PULL ONLY — these rows are never indexed/embedded; the digest text
// is built here, handed to the model once, and discarded. Fail-open: any DB error returns null so the
// answer still goes out (with the rest of the slice) rather than 502-ing on a documents hiccup.
//
// EXPORTED (2026-06-21, same-brain SOAP): the SOAP Overview must read the SAME extracted-chart digest Ask
// Aegis cites (Zimmelman: the SOAP was fed structured columns only and missed records Ask Aegis surfaced).
// One builder, both consumers — never a second digest path that can drift.
export async function buildDigestForCase(db: AppDb, caseId: string): Promise<string | null> {
  try {
    // #5 (Zimmelman, 2026-06-21): feed docs NEWEST-FIRST. buildDocumentDigest's per-doc FLOOR and tie-break
    // both prioritize the FRONT of this list, so newest-first guarantees the modern dx/decision survives the
    // total cap (older docs can no longer eat the whole budget and starve the newest records). The signal-desc
    // span sort still leads with the most decision-relevant pages regardless of upload order.
    const docs = (await db.document.findMany({
      where: { caseId },
      orderBy: { uploadedAt: 'desc' },
      select: { id: true, filename: true, docTag: true, pageCount: true },
    })) as unknown as readonly DigestDocInput[];
    if (docs.length === 0) return null;

    const ids = docs.map((d) => d.id);
    const pageRows = (await db.documentPage.findMany({
      where: { documentId: { in: ids } },
      orderBy: [{ documentId: 'asc' }, { pageNumber: 'asc' }],
      select: { documentId: true, pageNumber: true, text: true },
    })) as unknown as readonly DigestPageInput[];

    const byDoc = new Map<string, DigestPageInput[]>();
    for (const p of pageRows) {
      const arr = byDoc.get(p.documentId) ?? [];
      arr.push(p);
      byDoc.set(p.documentId, arr);
    }
    const { text } = buildDocumentDigest(docs, byDoc);
    return text;
  } catch {
    return null;
  }
}

// Parse an RFC-2822 / ISO date header to YYYY-MM-DD; fall back to a short trim of the raw value if
// it won't parse (the Gmail Date header is occasionally non-standard).
function isoDate(raw: string): string {
  const t = Date.parse(raw);
  return Number.isNaN(t) ? oneLine(raw, 24) : new Date(t).toISOString().slice(0, 10);
}

// Email thread: the LIVE Gmail correspondence with the veteran — the SAME source the EMR Email tab
// renders (gmail-readonly listVeteranCorrespondence), so Ask Aegis sees exactly what staff see in the
// chart. The EMR `Email` TABLE (email_log) is NOT what the Email tab shows (the tab calls
// /cases/:id/gmail-thread, i.e. live Gmail), so reading the table here MISSED the live thread — e.g.
// outbound staff notes that never sync into the table (Ryan 2026-06-16: "can you see that email in his
// chart?" → it was an outbound note visible only in live Gmail). Metadata + Gmail snippet only (no body
// fetch — cheap, cached 60s in the service, PHI-safe), rendered oldest→newest, redacted with the slice.
// Fail-open to null: degrades silently when the gmail.readonly scope isn't granted or Gmail hiccups.
async function buildEmailThreadForCase(vetEmail: string | null): Promise<string | null> {
  if (!vetEmail || vetEmail.trim().length === 0) return null;
  try {
    const corr = await listVeteranCorrespondence(vetEmail);
    if (!corr.available || corr.messages.length === 0) return null;
    // The service returns newest-first; take the recent window and render oldest→newest.
    const recent = corr.messages.slice(0, 25).reverse();
    return recent.map((m) => {
      const who = m.direction === 'inbound' ? 'Veteran' : 'Our team';
      const date = m.date ? isoDate(m.date) : '';
      return `  [${date}] ${who}: ${oneLine(m.subject, 120)}\n    ${oneLine(m.snippet, 400)}`;
    }).join('\n');
  } catch { return null; }
}

// Staff notes (ChartNote, veteran-scoped), most-recent window. Fail-open.
async function buildStaffNotesForCase(db: AppDb, veteranId: string | null): Promise<string | null> {
  if (!veteranId) return null;
  try {
    const rows = await (db as unknown as {
      chartNote: { findMany: (a: { where: { veteranId: string }; orderBy: { createdAt: 'desc' }; take: number; select: Record<string, true> }) => Promise<Array<{ body: string; createdAt: Date }>> };
    }).chartNote.findMany({
      where: { veteranId }, orderBy: { createdAt: 'desc' }, take: 30, select: { body: true, createdAt: true },
    });
    if (!rows || rows.length === 0) return null;
    return [...rows].reverse().map((n) => `  [${n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 10) : ''}] ${oneLine(n.body, 500)}`).join('\n');
  } catch { return null; }
}

// Internal staff messages on this case (CaseMessage) — the customer-tagged thread. Fail-open.
async function buildStaffMessagesForCase(db: AppDb, caseId: string): Promise<string | null> {
  try {
    const rows = await (db as unknown as {
      caseMessage: { findMany: (a: { where: { caseId: string }; orderBy: { createdAt: 'desc' }; take: number; select: Record<string, true> }) => Promise<Array<{ body: string; senderRole: string; createdAt: Date }>> };
    }).caseMessage.findMany({
      where: { caseId }, orderBy: { createdAt: 'desc' }, take: 30, select: { body: true, senderRole: true, createdAt: true },
    });
    if (!rows || rows.length === 0) return null;
    return [...rows].reverse().map((m) => `  [${m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : ''}] ${m.senderRole || 'staff'}: ${oneLine(m.body, 400)}`).join('\n');
  } catch { return null; }
}

export async function buildChartSlice(db: AppDb, caseId: string): Promise<ChartSlice | null> {
  const c = (await db.case.findFirst({
    where: { id: caseId },
    select: {
      claimType: true,
      claimedCondition: true,
      claimedConditions: true,
      upstreamScCondition: true,
      veteranId: true,
      veteranStatement: true,
      inServiceEvent: true,
      veteran: {
        select: {
          email: true,
          scConditions: { select: { condition: true, status: true, ratingPct: true, dcCode: true } },
          activeProblems: { select: { problem: true, icd10: true, notes: true } },
          activeMedications: { select: { drugName: true, indication: true } },
        },
      },
    },
  })) as ChartSliceRaw | null;
  if (c === null) return null;

  // All enrichments are best-effort + fail-open to null so a hiccup in any never blocks the answer.
  // Run in parallel (each owns its own try/catch). emails/notes/messages are Ask-Aegis-only chart context.
  const [caseFraming, documentDigest, emailThread, staffNotes, staffMessages] = await Promise.all([
    deriveCaseFramingForCase(db, caseId).catch(() => null),
    buildDigestForCase(db, caseId),
    buildEmailThreadForCase(c.veteran?.email ?? null),
    buildStaffNotesForCase(db, c.veteranId),
    buildStaffMessagesForCase(db, caseId),
  ]);

  const data: ChartSliceData = {
    claimType: c.claimType,
    claimedCondition: c.claimedCondition,
    claimedConditions: c.claimedConditions ?? [],
    upstreamScCondition: c.upstreamScCondition,
    // Reconcile so Ask Aegis sees the SAME collapsed SC list the chart UI + drafter do —
    // otherwise the "PTSD shown SC and pending" contradiction just moves into the AI answer
    // (QA finding, 2026-06-20). Same read-time helper; statusConflict rides along when relevant.
    scConditions: reconcileScConditions(c.veteran?.scConditions ?? []),
    activeProblems: c.veteran?.activeProblems ?? [],
    activeMedications: c.veteran?.activeMedications ?? [],
    veteranStatement: c.veteranStatement,
    inServiceEvent: c.inServiceEvent,
    caseFraming,
    documentDigest,
    emailThread,
    staffNotes,
    staffMessages,
  };
  const { text, conditions } = formatChartSlice(data);
  return { found: true, text: redactPhi(text), claimedCondition: c.claimedCondition, conditions };
}
