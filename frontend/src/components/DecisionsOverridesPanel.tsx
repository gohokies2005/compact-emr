import { useQuery } from '@tanstack/react-query';
import { getDraftDecisions, type DraftDecision } from '../api/drafter';
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

export function DecisionsOverridesPanel({ caseId }: { readonly caseId: string }) {
  const q = useQuery({ queryKey: ['case', caseId, 'draft-decisions'], queryFn: () => getDraftDecisions(caseId), enabled: caseId.length > 0 });
  const rows = q.data?.data ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">Decisions &amp; overrides</h3>
        <p className="mt-0.5 text-xs text-slate-500">A plain-language record of every checklist confirmation, automated check, and RN override on this case.</p>
      </div>
      <div className="divide-y divide-slate-100">
        {rows.map((d) => {
          const { text, by } = describeDecision(d);
          return (
            <div key={d.id} className="px-4 py-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="text-slate-800">{text}</span>
                <span className="shrink-0 text-xs text-slate-400">{by} · {formatRelativeTime(d.createdAt)}</span>
              </div>
              {d.reason ? <p className="mt-1 text-slate-600">“{d.reason}”</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
