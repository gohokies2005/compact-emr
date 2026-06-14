import { useState } from 'react';
import type { StrategyInputSet, ChainAttempt } from '../api/strategy-preview';

// E5 trustworthy viability (2026-06-13). Three shared, advisory-only presentational pieces used by
// BOTH the strategy-preview and the anchor-viability cards, so a verdict NEVER renders without the
// inputs the RN can sanity-check it against (the Woodley lesson — a "no" you can't see the inputs to
// is untrustworthy). None of these change a verdict; they only make it auditable at a glance.

// ── 1. INPUT VISIBILITY ──────────────────────────────────────────────────────
// "Computed from N facts" + a disclosure listing the exact SC conditions, meds, comorbid problems,
// and key facts the engine actually had. A missing SC condition / med is then obvious on sight, and a
// thin-parse "no" (factCount=2 on a 1,000pp chart) is distrusted immediately.
export function InputVisibility({ inputSet }: { readonly inputSet: StrategyInputSet }) {
  const [open, setOpen] = useState(false);
  const { scConditions, medications, activeProblems, keyFacts, factCount } = inputSet;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="text-xs text-slate-400 hover:text-slate-600"
        title="The exact facts this verdict was computed from — a missing condition/med should be obvious here"
      >
        {open ? 'Computed from these facts ▲' : `Computed from ${factCount} fact${factCount === 1 ? '' : 's'} ▼`}
      </button>
      {open ? (
        <dl className="mt-2 space-y-1.5 text-xs">
          <InputRow label="Service-connected" items={scConditions} emptyHint="none extracted — verify the chart parsed the rating decision" />
          <InputRow
            label="Current meds"
            items={medications.map((m) => (m.indication ? `${m.drugName} (for ${m.indication})` : m.drugName))}
            emptyHint="none extracted"
          />
          <InputRow label="Active problems" items={activeProblems} emptyHint="none extracted" />
          <InputRow label="Key facts" items={keyFacts.map((f) => `${f.label}: ${f.value}`)} emptyHint="none on file" />
        </dl>
      ) : null}
    </div>
  );
}

function InputRow({ label, items, emptyHint }: { readonly label: string; readonly items: readonly string[]; readonly emptyHint: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 flex-none font-medium text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-700">
        {items.length > 0 ? items.join(', ') : <span className="italic text-slate-400">{emptyHint}</span>}
      </dd>
    </div>
  );
}

// ── 2. INTERMEDIARY CHAIN ────────────────────────────────────────────────────
// When the direct pathway failed, the engine auto-searched a two-hop chain. We surface EITHER the
// recovered chain (SC → intermediary → claimed, with where the bridge came from) OR an honest
// "searched, none found" line — so a decline is never a silent flat-no.
export function ChainPathwayNote({ chainAttempt }: { readonly chainAttempt: ChainAttempt }) {
  if (!chainAttempt.searched) return null;
  const p = chainAttempt.pathway;
  if (p === null) {
    return (
      <div className="mt-1 text-xs text-slate-500">
        No direct service-connected pathway — also checked indirect (two-step) pathways through the
        veteran’s other conditions and medications; none recognized on record.
      </div>
    );
  }
  const bridgeSource = p.intermediarySource === 'medication_indication' ? 'treated by a current medication' : 'a comorbid diagnosis';
  return (
    <div className="mt-1 text-sm text-slate-700">
      <span className="font-medium">Indirect pathway found:</span>{' '}
      <span className="font-medium">{p.anchor}</span> → {p.intermediary} → {p.hops[1].to}{' '}
      <span className="text-slate-500">(via {p.intermediary}, {bridgeSource}) — consider arguing the chain.</span>
    </div>
  );
}

// ── 3. COMPLETENESS SIGNAL ───────────────────────────────────────────────────
// When part of the record went unparsed (OCR-blocked files, or extraction gaps), the card says so —
// a thin parse must never masquerade as a confident "no". Renders nothing when the chart is complete.
export interface CompletenessState {
  readonly unreadFileCount: number;
  readonly uncoveredPages: number;
  readonly truncatedWindows: number;
}

export function CompletenessSignal({ state }: { readonly state: CompletenessState | null }) {
  if (state === null) return null;
  const { unreadFileCount, uncoveredPages, truncatedWindows } = state;
  if (unreadFileCount === 0 && uncoveredPages === 0 && truncatedWindows === 0) return null;
  const parts: string[] = [];
  if (unreadFileCount > 0) parts.push(`${unreadFileCount} file${unreadFileCount === 1 ? '' : 's'} not read`);
  if (uncoveredPages > 0) parts.push(`${uncoveredPages} page${uncoveredPages === 1 ? '' : 's'} not parsed`);
  if (truncatedWindows > 0) parts.push(`${truncatedWindows} dense section${truncatedWindows === 1 ? '' : 's'} partially parsed`);
  return (
    <div className="mt-2 flex items-start gap-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-xs text-amber-800">
      <span aria-hidden="true">⚠</span>
      <span>
        {parts.join(', ')} — this verdict may be incomplete. Reprocess the documents if a key fact (an SC
        rating, a medication) could be on an unread page.
      </span>
    </div>
  );
}
