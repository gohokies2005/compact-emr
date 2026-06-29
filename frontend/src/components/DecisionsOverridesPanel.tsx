import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDraftDecisions, type DraftDecision } from '../api/drafter';
import { getDraftReadiness } from '../api/draft-readiness';
import { patchCase } from '../api/cases';
import { describeApiError } from '../api/client';
import { formatRelativeTime } from '../lib/date';

/**
 * In-chart "Decisions & overrides" log — Gate-1 attestations, Gate-2 halt findings, and every RN
 * override/switch/proceed, with the FULL typed reason, who, and when. Per the owner's hard rule:
 * every override reason must be visible in the chart, never log-only. Renders nothing if empty.
 *
 * Ryan 2026-06-06: the raw rows ("prior_denial — Checklist · yes" + a uuid) were unreadable.
 * Now every row is a plain-English sentence; the actor is a role word (not a uuid); panel lives at
 * the very bottom of the case screen.
 */

// The thing each checklist item / halt finding concerns, in plain words.
const ITEM_NOUN: Record<string, string> = {
  in_service_event: 'an in-service event, injury, or exposure is documented',
  dx_present: 'a current diagnosis of the claimed condition is documented',
  sc_conditions: "the veteran's service-connected conditions are documented",
  prior_denial: 'the prior denial letter is on file',
  nexus_judgment: 'a plausible medical nexus to author',
  dx_verification: 'the diagnosis',
  nexus_switch: "the letter's condition",
};

/** Turn a raw decision row into { text: a sentence, by: a role word }. */
function describeDecision(d: DraftDecision): { text: string; by: string } {
  const noun = ITEM_NOUN[d.item] ?? d.item.replace(/_/g, ' ');
  if (d.gate === 1) {
    // Human "before we draft" checklist (Gate-1) — the actor is always the RN.
    switch (d.decision) {
      case 'yes': return { text: `RN confirmed: ${noun} ✓`, by: 'RN' };
      case 'not_applicable': return { text: `RN marked not applicable: ${noun}`, by: 'RN' };
      case 'override': return { text: `RN proceeded without confirming ${noun} (override)`, by: 'RN' };
      case 'no': return { text: `RN flagged as missing: ${noun}`, by: 'RN' };
      default: return { text: `RN — ${noun}: ${d.decision}`, by: 'RN' };
    }
  }
  // Gate-2: the automated dx/event check (decision no/pause) and the RN's response to it.
  switch (d.decision) {
    case 'no': return { text: `Automated check could not confirm ${noun}`, by: 'AI check' };
    case 'pause': return { text: 'Automated check paused drafting to gather more records', by: 'AI check' };
    case 'override': return { text: 'RN overrode the automated check — drafting on the claimed condition', by: 'RN' };
    case 'switch_accept': return { text: "RN switched the letter to a better-fitting condition", by: 'RN' };
    case 'proceed': return { text: 'RN confirmed the records are in — drafting resumed', by: 'RN' };
    default: return { text: `Automated check — ${noun}: ${d.decision}`, by: 'AI check' };
  }
}

/**
 * PRECEDENCE (work order Task 5, audit D1): the Gate-2 automated check reads the actual documents,
 * so it is the authority over a human checkbox. A Gate-1 "RN confirmed ✓" whose item a LATER Gate-2
 * finding could not confirm renders as superseded — not as an equal, contradicting log line. A
 * re-attestation AFTER the Gate-2 finding is newer evidence and is not struck.
 */
function isSuperseded(d: DraftDecision, rows: readonly DraftDecision[]): boolean {
  if (d.gate !== 1 || d.decision !== 'yes') return false;
  return rows.some((r) =>
    r.gate === 2
    && r.item === d.item
    && (r.decision === 'no' || r.decision === 'pause')
    && new Date(r.createdAt).getTime() > new Date(d.createdAt).getTime());
}

const FRAMING_SOURCE_LABEL: Record<string, string> = {
  rn_set: 'set by RN',
  derived: 'auto-derived from the granted SC conditions',
  text_parse_fallback: 'parsed from the veteran’s intake wording',
  default_direct: 'default (direct)',
};

export function DecisionsOverridesPanel({ caseId, caseVersion }: { readonly caseId: string; readonly caseVersion?: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['case', caseId, 'draft-decisions'], queryFn: () => getDraftDecisions(caseId), enabled: caseId.length > 0 });
  // Same cache key as the Gate-1 modal's feed — one fetch serves both surfaces.
  const readinessQ = useQuery({ queryKey: ['case', caseId, 'draft-readiness'], queryFn: () => getDraftReadiness(caseId), enabled: caseId.length > 0 });
  const cf = readinessQ.data?.data.caseFraming;

  const editFraming = useMutation({
    mutationFn: (input: { framingChoice: string | null; upstreamScCondition: string | null }) => {
      if (caseVersion === undefined) throw new Error('case version unavailable');
      return patchCase(caseId, { version: caseVersion, ...input });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['case', caseId] }),
    onError: (e: unknown) => window.alert(`Could not update the framing — ${describeApiError(e)}`),
  });

  function onEditFraming() {
    if (cf === undefined) return;
    const framing = window.prompt('Framing (secondary / aggravation / direct — blank to clear):', cf.framingChoice ?? cf.framing);
    if (framing === null) return;
    const f = framing.trim().toLowerCase();
    if (f.length > 0 && !['secondary', 'aggravation', 'direct'].includes(f)) {
      window.alert('Framing must be secondary, aggravation, or direct (or blank to clear).');
      return;
    }
    const upstream = window.prompt('Upstream SC condition (blank to clear):', cf.upstreamScCondition ?? '');
    if (upstream === null) return;
    editFraming.mutate({ framingChoice: f.length > 0 ? f : null, upstreamScCondition: upstream.trim().length > 0 ? upstream.trim() : null });
  }

  const rows = q.data?.data ?? [];
  // Provenance is worth showing even before any decision exists (the RN sets framing pre-draft);
  // hide the panel only when BOTH the log and the framing feed are empty.
  if (rows.length === 0 && cf === undefined) return null;
  return (
    <div className="rounded-2xl border border-aegis bg-ivory shadow-aegis-card">
      <div className="border-b border-aegis px-4 py-3">
        <h3 className="text-sm font-semibold text-navyDeep">Decisions &amp; overrides</h3>
        <p className="mt-0.5 text-xs text-harbor">A plain-language record of every checklist confirmation, automated check, and RN override on this case.</p>
        {cf !== undefined ? (
          <p className="mt-2 text-xs text-harbor">
            <span className="font-semibold text-navyDeep">Framing:</span>{' '}
            <span className="font-medium">{cf.framing}</span>
            {' · '}{FRAMING_SOURCE_LABEL[cf.source] ?? cf.source}
            {cf.upstreamScCondition !== null ? <> · anchor: {cf.upstreamScCondition}</> : null}
            {caseVersion !== undefined ? (
              <button type="button" className="ml-2 rounded border border-aegis px-1.5 py-0.5 text-xs text-navyDeep hover:bg-mist" disabled={editFraming.isPending} onClick={onEditFraming}>
                Edit framing
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="divide-y divide-mist">
        {rows.map((d) => {
          const { text, by } = describeDecision(d);
          const superseded = isSuperseded(d, rows);
          return (
            <div key={d.id} className="px-4 py-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className={superseded ? 'text-harbor line-through decoration-harbor/60' : 'text-navyDeep'}>{text}</span>
                <span className="shrink-0 text-xs text-harbor">{by} · {formatRelativeTime(d.createdAt)}</span>
              </div>
              {superseded ? (
                <p className="mt-1 text-xs font-medium text-amber-700">Superseded — a later automated document check could not confirm this. See the AI check entry.</p>
              ) : null}
              {d.reason ? <p className="mt-1 text-steel">“{d.reason}”</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
