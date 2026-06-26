import { useMemo, useState } from 'react';
import { Button } from './ui/Button';
import { ServiceUnavailableError, SurgicalEditUnappliableError } from '../api/client';
import { proposeGuidedRevision, type GuidedRevisionResult, type SurgicalProposal } from '../api/letter';
import { citationMayBeOffTopic } from '../lib/citationRelevance';
import { RevisionPreviewModal } from './RevisionPreviewModal';

// Does the instruction look like it's WEAVING IN a citation/finding (vs a pure reword)? Only then do
// we run the soft relevance check — a "tighten this paragraph" instruction shouldn't get a citation
// advisory. Cheap keyword sniff, deterministic.
const CITATION_INSTRUCTION_RE = /\b(cite|citation|cited|citing|reference|pmid|study|studies|finding|evidence|weave|add)\b/i;

// Guided Revision UI (2026-06-13): the broader physician edit tier, a SIBLING of the surgical-AI
// card. The physician HIGHLIGHTS a verbatim passage of the letter (captured by LetterEditor's
// onSelectPassage), gives an instruction, and Opus reshapes ONLY that passage. The whole point is
// that the doctor SEES what changed — and any guard trip — before accepting, so this panel
// PROMINENTLY surfaces warnings, sanity findings, the citation diff (especially dropped citations),
// and the backend's rejection states. Accept reuses the EXISTING surgical apply door via onApply.

interface GuidedRevisionPanelProps {
  readonly caseId: string;
  // The verbatim highlighted passage, or null when nothing is selected. Drives the entry state.
  readonly passage: string | null;
  // Hand the accepted proposal to the shared surgical-apply machinery (applySurgicalAi). Returns a
  // promise so this panel can show a pending state and clear itself on success.
  readonly onApply: (proposal: SurgicalProposal) => Promise<void>;
  // True once the backend has 503'd guided_revision_disabled this session — the entry point is then
  // disabled with an explanatory tooltip rather than letting the doctor keep hitting a dead feature.
  readonly disabledByFlag: boolean;
  readonly onFlagDisabled: () => void;
}

// A rejection the physician must see — never applyable. `addedCitations` is populated on
// citation_invented so the copy can name what the model tried to introduce.
interface Rejection {
  readonly reason: string;
  readonly addedCitations: readonly string[];
}

function rejectionCopy(r: Rejection): string {
  if (r.reason === 'citation_invented') {
    const cites = r.addedCitations.length > 0 ? ` (${r.addedCitations.join(', ')})` : '';
    return `Rejected: the revision introduced a citation/statistic not in the original${cites} — refine your instruction so it only rewords the existing facts.`;
  }
  if (r.reason === 'holding_changed') return 'Rejected: that would change the opinion’s conclusion (the Section VII holding), which is locked.';
  if (r.reason === 'passage_not_found') return 'Rejected: the highlighted passage was not found in the current letter — re-select the text and try again.';
  if (r.reason === 'edit_unappliable') return 'Rejected: the proposed edit no longer fits the current draft — re-select the passage and try again.';
  if (r.reason === 'passage_required') return 'Rejected: select the passage to revise before submitting.';
  return 'Rejected: the revision could not be applied. Refine your instruction and try again.';
}

// proposal_unavailable (Guided-revision robustness, 2026-06-24): the LLM proposer failed transiently
// or returned an empty/truncated edit. EVERY case gets a specific, actionable message — never the
// generic "could not be generated". `detail` discriminates the cause.
function proposalUnavailableMessage(detail: string | undefined): string {
  if (detail === 'model_unavailable') return 'The AI service was briefly unavailable. Click Propose revision again in a moment.';
  if (detail === 'passage_too_complex') return 'The AI couldn’t shape a clean edit for this passage — it may be too long. Try a smaller selection (up to about two pages), or hand-edit it directly in the letter.';
  // no_change_proposed (or any unrecognized detail)
  return 'The AI didn’t return an edit for this passage. Try rephrasing the instruction, narrow the selection, or hand-edit it directly in the letter.';
}

export function GuidedRevisionPanel({ caseId, passage, onApply, disabledByFlag, onFlagDisabled }: GuidedRevisionPanelProps) {
  const [instruction, setInstruction] = useState('');
  const [result, setResult] = useState<GuidedRevisionResult | null>(null);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [expanded, setExpanded] = useState(false); // expand the revised-letter preview into a ~2/3-screen modal

  // SOFT relevance advisory (Dr. Kasky 2026-06-25): when the instruction is weaving a citation/finding
  // INTO the highlighted passage, gently flag if that instruction barely overlaps the passage topic —
  // i.e. the physician may be grafting an off-topic citation onto this claim. NEVER blocks; Propose +
  // Accept stay live. Quiet for pure rewording instructions and when no passage is selected.
  const citationMayNotFit = useMemo(() => {
    if (passage === null) return false;
    const instr = instruction.trim();
    if (instr.length === 0 || !CITATION_INSTRUCTION_RE.test(instr)) return false;
    return citationMayBeOffTopic(instr, passage);
  }, [instruction, passage]);

  function reset() {
    setResult(null);
    setRejection(null);
    setError(null);
  }

  async function onPropose() {
    if (passage === null || instruction.trim().length === 0) return;
    reset();
    setProposing(true);
    try {
      const res = await proposeGuidedRevision(caseId, { passage, instruction: instruction.trim() });
      setResult(res.data);
    } catch (err: unknown) {
      // 503 → the feature flag is off; disable the entry point (no point retrying this session).
      if (err instanceof ServiceUnavailableError) { onFlagDisabled(); setError('Guided Revision isn’t enabled yet.'); return; }
      // 422 → a guard tripped OR the proposer was unavailable/returned nothing usable.
      if (err instanceof SurgicalEditUnappliableError) {
        const reason = typeof err.details?.reason === 'string' ? err.details.reason : 'edit_unappliable';
        // proposal_unavailable is NOT a medico-legal rejection — it's a transient/too-complex
        // failure with a SPECIFIC, actionable message. Surface it in the neutral error slot (not the
        // red rejection block) so the physician knows exactly what to do, never the generic fallback.
        if (reason === 'proposal_unavailable') { setError(proposalUnavailableMessage(err.details?.detail)); return; }
        const added = (err.details?.citationDiff?.added ?? [])
          .map((t) => (typeof t?.raw === 'string' ? t.raw : ''))
          .filter((s) => s.length > 0);
        setRejection({ reason, addedCitations: added });
        return;
      }
      setError('Guided revision could not be generated. Refine your instruction and try again.');
    } finally {
      setProposing(false);
    }
  }

  async function onAccept() {
    if (result === null) return;
    setApplying(true);
    try {
      await onApply(result.proposal);
      // The parent reloads the letter on success; clear this panel's local state.
      setInstruction('');
      reset();
    } catch {
      setError('The revision could not be applied. Re-select the passage and try again.');
    } finally {
      setApplying(false);
    }
  }

  if (disabledByFlag) {
    return (
      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500" title="GUIDED_REVISION_ENABLED is off in this environment">
        Guided Revision isn’t enabled in this environment.
      </div>
    );
  }

  const removedCitations = result?.citationDiff.removed ?? [];

  return (
    <div className="mt-6 border-t border-slate-200 pt-4">
      <h3 className="text-base font-semibold text-slate-900">Guided Revision</h3>
      <p className="mt-1 text-sm text-slate-600">
        Highlight a passage in the letter, then describe how to reshape just that passage. The opinion (Section VII) and the cited facts are locked.
      </p>

      {passage === null ? (
        <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-500">
          Select text in the letter to revise it.
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Selected passage</div>
          <div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-['Times_New_Roman',Times,serif] text-sm text-slate-800">{passage}</div>
        </div>
      )}

      <label className="mt-3 block">
        <span className="text-sm font-medium text-slate-800">Revision instruction</span>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
          maxLength={1000}
          className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
          placeholder="Example: tighten this paragraph and lead with the mechanism."
        />
      </label>
      {/* SOFT, NON-BLOCKING relevance advisory — the physician may proceed regardless. */}
      {citationMayNotFit ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          The citation you’re weaving in may not support this passage — proceed if you’ve confirmed it fits.
        </div>
      ) : null}

      <Button
        type="button"
        variant="secondary"
        className="mt-3 w-full"
        loading={proposing}
        disabled={proposing || passage === null || instruction.trim().length === 0}
        onClick={() => void onPropose()}
      >
        Propose revision
      </Button>

      {error ? <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{error}</div> : null}

      {/* REJECTION — medico-legal guard tripped. Never applyable; no Accept button is rendered. */}
      {rejection ? (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {rejectionCopy(rejection)}
        </div>
      ) : null}

      {/* PROPOSAL — show it SAFELY: diff/preview, warnings, sanity, dropped-citation acknowledgement. */}
      {result ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-semibold text-slate-900">Proposed revision{result.costUsd > 0 ? ` · $${result.costUsd.toFixed(2)}` : ''}</div>

          {/* Dropped citations — the doctor must SEE what this revision removes before accepting. */}
          {removedCitations.length > 0 ? (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
              <div className="font-semibold">This revision drops {removedCitations.length === 1 ? 'a citation' : 'citations'}:</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {removedCitations.map((t) => <li key={t.key}>{t.raw}</li>)}
              </ul>
              <div className="mt-1">Confirm this is intended before accepting.</div>
            </div>
          ) : null}

          {/* Backend warnings (string sentences) + sanity findings on the would-be revised letter. */}
          {result.warnings.length > 0 ? (
            <ul className="mt-3 list-disc space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 pl-7 text-sm text-amber-800">
              {result.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          ) : null}
          {result.sanity.length > 0 ? (
            <ul className="mt-3 list-disc space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 pl-7 text-sm text-amber-800">
              {result.sanity.map((s) => <li key={s.rule}>{s.detail}</li>)}
            </ul>
          ) : null}

          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Revised letter preview</span>
            <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-indigo-600 hover:bg-indigo-50 hover:text-indigo-800"
              title="Expand to read full-size" aria-label="Expand the revised letter preview" onClick={() => setExpanded(true)}>
              <span aria-hidden="true">⤢</span> Expand
            </button>
          </div>
          <div className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-white p-3 font-['Times_New_Roman',Times,serif] text-sm text-slate-800">{result.preview}</div>

          <div className="mt-3 flex gap-2">
            <Button type="button" variant="primary" loading={applying} disabled={applying} onClick={() => void onAccept()}>Accept revision</Button>
            <Button type="button" variant="secondary" onClick={reset}>Discard</Button>
          </div>
        </div>
      ) : null}

      {expanded && result ? (
        <RevisionPreviewModal
          title="Proposed revision — revised letter preview"
          subtitle={result.costUsd > 0 ? `$${result.costUsd.toFixed(2)}` : null}
          preview={result.preview}
          applying={applying}
          acceptLabel="Accept revision"
          declineLabel="Discard"
          onAccept={() => { setExpanded(false); void onAccept(); }}
          onDecline={() => { setExpanded(false); reset(); }}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </div>
  );
}
