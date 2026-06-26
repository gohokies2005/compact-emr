import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/Button';
import { ServiceUnavailableError, SurgicalEditUnappliableError } from '../api/client';
import {
  applyCitationEnrich,
  pollCitationEnrich,
  proposeCitationEnrich,
  type EnrichCandidate,
} from '../api/letter';

// Citation Enricher (Feature B, 2026-06-24) — PHYSICIAN-ONLY panel, a sibling of Guided Revision.
// The physician enters a claim sentence (or a condition) + optional mechanism hints, the backend
// runs a GROUNDED NCBI search (real, verified PubMed PMIDs), and the panel previews candidates with
// the verbatim "killer finding" + a PubMed link. The physician checks the ones to add and clicks
// "Add selected" — the backend RE-VERIFIES each PMID server-side, inserts deterministically, and
// the parent refetches the letter. Nothing here is trusted at apply: the server re-verifies.

interface CitationEnricherPanelProps {
  readonly caseId: string;
  // Optional: the verbatim highlighted passage (a claim sentence) the physician selected. When
  // present it pre-fills the claim box so a highlighted sentence drives the search.
  readonly passage: string | null;
  // Called after a successful apply so the parent can refetch the letter (mirrors Guided Revision).
  readonly onApplied: () => void;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000; // the grounded retrieval is several serial NCBI round-trips

export function CitationEnricherPanel({ caseId, passage, onApplied }: CitationEnricherPanelProps) {
  const [claim, setClaim] = useState('');
  const [condition, setCondition] = useState('');
  const [hints, setHints] = useState('');
  const [status, setStatus] = useState<'idle' | 'searching' | 'ready' | 'error'>('idle');
  const [candidates, setCandidates] = useState<readonly EnrichCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The jobId of the ready candidates, captured at propose time + carried to apply.
  const jobIdRef = useRef<string | null>(null);

  // Clear any in-flight poll on unmount.
  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

  // Pre-fill the claim from a highlighted passage (a sentence the physician wants citations for).
  useEffect(() => { if (passage !== null && passage.trim().length > 0) setClaim(passage.trim()); }, [passage]);

  function reset() {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
    setStatus('idle');
    setCandidates([]);
    setSelected(new Set());
    setError(null);
  }

  async function onFind() {
    if (claim.trim().length === 0 && condition.trim().length === 0) return;
    reset();
    setStatus('searching');
    const mechanismHints = hints.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
    try {
      const proposed = await proposeCitationEnrich(caseId, {
        ...(claim.trim().length > 0 ? { claim: claim.trim() } : {}),
        ...(condition.trim().length > 0 ? { condition: condition.trim() } : {}),
        ...(mechanismHints.length > 0 ? { mechanismHints } : {}),
      });
      const jobId = proposed.data.jobId;
      jobIdRef.current = jobId;
      const startedAt = Date.now();
      const poll = async () => {
        try {
          const res = await pollCitationEnrich(caseId, jobId);
          if (res.data.status === 'ready') {
            setCandidates(res.data.candidates ?? []);
            setStatus('ready');
            return;
          }
          if (res.data.status === 'error') {
            setError(res.data.error ?? 'No grounded citations were found. Try a broader condition.');
            setStatus('error');
            return;
          }
          if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            setError('The citation search timed out. Try again or narrow the search.');
            setStatus('error');
            return;
          }
          pollTimer.current = setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
        } catch {
          setError('Could not retrieve citations. Please try again.');
          setStatus('error');
        }
      };
      pollTimer.current = setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
    } catch (err: unknown) {
      if (err instanceof ServiceUnavailableError) { setError('Citation enrichment isn’t enabled in this environment.'); setStatus('error'); return; }
      setError('Could not start the citation search. Please try again.');
      setStatus('error');
    }
  }

  function toggle(pmid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pmid)) next.delete(pmid); else next.add(pmid);
      return next;
    });
  }

  async function onAddSelected() {
    const jobId = jobIdRef.current;
    if (selected.size === 0 || jobId === null) return;
    setApplying(true);
    setError(null);
    try {
      // The backend RE-VERIFIES every selected PMID against NCBI before inserting — a client flag is
      // never trusted. On a re-verify or guard failure the API 422s and nothing is changed.
      await applyCitationEnrich(caseId, { jobId, selectedPmids: [...selected] });
      reset();
      setClaim('');
      setCondition('');
      setHints('');
      onApplied();
    } catch (err: unknown) {
      if (err instanceof SurgicalEditUnappliableError) {
        const reason = typeof err.details?.reason === 'string' ? err.details.reason : '';
        setError(
          reason === 'citation_unverified'
            ? 'One or more selected citations could not be re-verified against PubMed — nothing was added. Re-run the search and try different results.'
            : 'The citations could not be added — nothing was changed. Re-run the search and try again.',
        );
        return;
      }
      if (err instanceof ServiceUnavailableError) { setError('Citation enrichment isn’t enabled in this environment.'); return; }
      setError('The citations could not be added. Please try again.');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="mt-6 border-t border-slate-200 pt-4">
      <h3 className="text-base font-semibold text-slate-900">Citation Enricher</h3>
      <p className="mt-1 text-sm text-slate-600">
        Find real, verified PubMed citations for a claim. Every result is grounded in NCBI (no AI-invented references). Preview, then add the ones you want to the references.
      </p>

      <label className="mt-3 block">
        <span className="text-sm font-medium text-slate-800">Claim sentence (or highlight one in the letter)</span>
        <textarea
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          rows={2}
          maxLength={1000}
          className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
          placeholder="Example: OSA is more likely than not aggravated by service-connected PTSD."
        />
      </label>
      <label className="mt-3 block">
        <span className="text-sm font-medium text-slate-800">Or a condition to search</span>
        <input
          type="text"
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          maxLength={200}
          className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
          placeholder="Example: obstructive sleep apnea"
        />
      </label>
      <label className="mt-3 block">
        <span className="text-sm font-medium text-slate-800">Mechanism hints (optional, comma-separated)</span>
        <input
          type="text"
          value={hints}
          onChange={(e) => setHints(e.target.value)}
          maxLength={200}
          className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
          placeholder="Example: intermittent hypoxia, sympathetic activation"
        />
      </label>

      <Button
        type="button"
        variant="secondary"
        className="mt-3 w-full"
        loading={status === 'searching'}
        disabled={status === 'searching' || (claim.trim().length === 0 && condition.trim().length === 0)}
        onClick={() => void onFind()}
      >
        Find citations
      </Button>

      {status === 'searching' ? (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          Searching PubMed for grounded citations… this can take a few seconds.
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</div>
      ) : null}

      {status === 'ready' && candidates.length > 0 ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-semibold text-slate-900">Verified candidates</div>
          <ul className="mt-3 space-y-3">
            {candidates.map((c) => (
              <li key={c.pmid} className="rounded-lg border border-slate-200 bg-white p-3">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(c.pmid)}
                    onChange={() => toggle(c.pmid)}
                    aria-label={`Add citation PMID ${c.pmid}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900">{c.title}</span>
                    <span className="block text-xs text-slate-500">{c.journal}{c.year ? ` · ${c.year}` : ''} · PMID {c.pmid}</span>
                    <span className="mt-1 block text-xs italic text-slate-700">“{c.killer_finding}”</span>
                    <a href={c.pubmedUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-medium text-blue-700 hover:underline">View on PubMed</a>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs text-slate-500">
            Selected citations are added as numbered references in Section VIII. To weave a finding into the Section VI prose, use Guided Revision and reference the new reference number or PMID.
          </p>

          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              variant="primary"
              loading={applying}
              disabled={applying || selected.size === 0}
              onClick={() => void onAddSelected()}
            >
              Add selected
            </Button>
            <Button type="button" variant="secondary" onClick={reset}>Discard</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
