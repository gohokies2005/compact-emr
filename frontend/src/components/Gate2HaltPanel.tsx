import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { postDraft, type RnDecisionInput } from '../api/drafter';
import { patchCase, transitionCaseStatus, type CaseDetail } from '../api/cases';
import { ConflictError, describeApiError } from '../api/client';
import { isBodyQualityHalt, type DraftJob, type Gate2HaltPayload } from '../types/prisma';

/**
 * Gate-2 halt screen — shown when the pre-draft dx/event verification PARKED the case
 * (status needs_rn_decision / needs_records). Renders the plain-English reason + the per-finding
 * verdict breakdown (what the automated check found, with its evidence quote) + any switch
 * proposal, and gives the RN actionable buttons (NEVER a dead-end): override + draft as-is,
 * switch to the better-fit dx, "records are in — re-run", or pause to gather records. Each is
 * logged + shown in the Decisions panel.
 */

/** One gate finding row: tri-state verdict (found / not_found / uncertain) + optional evidence. */
function FindingRow({ label, verdict, evidence }: { readonly label: string; readonly verdict: string; readonly evidence?: string | null | undefined }) {
  const v = verdict === 'found' ? { icon: '✓', cls: 'text-green-700', text: 'Found' }
    : verdict === 'not_found' ? { icon: '✗', cls: 'text-red-700', text: 'Not found' }
    : { icon: '?', cls: 'text-amber-700', text: 'Uncertain' };
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-0.5 w-4 flex-none text-center font-bold ${v.cls}`} aria-hidden="true">{v.icon}</span>
      <span>
        <span className="font-medium text-slate-800">{label}:</span>{' '}
        <span className={`font-semibold ${v.cls}`}>{v.text}</span>
        {evidence && evidence.trim().length > 0 ? (
          <span className="block text-xs text-slate-600">&ldquo;{evidence.trim()}&rdquo;</span>
        ) : null}
      </span>
    </li>
  );
}
/** Humanize a body-quality finding id ('section7_dual_prong_missing_regs') into a short defect label. */
const BODY_QUALITY_DEFECT_LABELS: Readonly<Record<string, string>> = {
  letter_ssn_file_line_in_preamble: 'SSN / VA file number in the letter preamble',
  letter_recipient_address_in_preamble: 'Hardcoded recipient address / salutation in the preamble',
  section7_editorial_directive_leak: 'Editorial / restructuring directive leaked into Section VII',
  letter_scope_creep_counsel_advocacy: 'Advocacy / counsel scope-creep in the letter prose',
  letter_leak_token_in_prose: 'Editorial / restructuring directive token leaked into the prose',
  section7_dual_prong_missing_regs: 'Section VII missing a required regulatory prong (causation + aggravation)',
  section7_aggravation_only_missing_3310b: 'Section VII aggravation claim missing the 3.310(b) prong',
  section7_causation_prong_on_aggravation_only_pair: 'Section VII causation prong on an aggravation-only pairing',
  pmid_not_found: 'A cited PMID was not found (possible fabricated citation)',
  pmid_content_mismatch: 'A cited PMID does not match the citation content',
  locked_section_i_modified: 'Locked Section I (physician qualifications) was modified',
  locked_section_ii_modified: 'Locked Section II (methodology) was modified',
  letter_self_undercut: 'The letter undercuts its own opinion',
  letter_section_iii_list_format: 'Section III is a list — it must be one prose paragraph',
  letter_placeholder_token_in_prose: 'A scaffolding / placeholder token was left in the prose',
};
function defectLabel(id: string): string {
  return BODY_QUALITY_DEFECT_LABELS[id] ?? id.replace(/_/g, ' ');
}

/**
 * Body-quality park card — a FULL draft was produced but the deterministic body-quality gate found a
 * letter-killing MATERIAL defect, so the letter is held for a targeted RE-DRAFT. This is NOT a
 * dx/event verification hold, so the dx switch / override / "records are in" actions do not apply —
 * the one action is to re-draft. Styled consistently with the dx halt card (amber), but the verb is
 * "re-draft" and the defect list shows the specific issue(s) + section(s) from the FRN park payload.
 */
function BodyQualityHoldCard({ c, payload, job, onChanged, onOpenEditor }: { readonly c: CaseDetail; readonly payload: Gate2HaltPayload; readonly job?: DraftJob; readonly onChanged: () => void | Promise<void>; readonly onOpenEditor?: () => void }) {
  // A produced draft exists when /halt confirmed + persisted an artifact key (option A, 2026-06-22).
  // When it does, the hold is ADVISORY/editable — the RN can open + fix the flagged section by hand
  // (far cheaper than a ~$15 re-draft). When no key exists (the txt was genuinely missing), the only
  // path is re-draft. The presence of the key is the SAME signal getLetter uses to resolve the letter.
  const hasProducedDraft =
    (typeof job?.artifactTxtS3Key === 'string' && job.artifactTxtS3Key.length > 0) ||
    (typeof job?.artifactPdfS3Key === 'string' && job.artifactPdfS3Key.length > 0);
  const canOpenEditor = hasProducedDraft && onOpenEditor !== undefined;

  const message = payload.plainEnglish || payload.operatorMessage || c.operatorMessage
    || 'The automated quality gate flagged a letter-killing issue that should be fixed before a physician sees this letter. The draft was not discarded.';
  // Accept BOTH payload shapes: the forthcoming richer `material:[{id,section,detail}]` and the
  // current `materialIds:[string]`. Normalize to a single render list.
  const findings = (payload.material && payload.material.length > 0)
    ? payload.material.map((f) => ({ id: f.id, section: f.section ?? null, detail: f.detail ?? null }))
    : (payload.materialIds ?? []).map((id) => ({ id, section: null as string | null, detail: null as string | null }));

  const redraft = useMutation({
    mutationFn: () => postDraft(c.id, { rnDecision: { proceed: true } }),
    onSuccess: () => void onChanged(),
    onError: (e: unknown) => window.alert(`Could not start the re-draft — ${describeApiError(e)}`),
  });
  function doRedraft() {
    if (!window.confirm('Re-draft this letter? The flagged defect(s) will be re-generated. The prior draft stays attached for reference.')) return;
    redraft.mutate();
  }

  // FORWARD DOOR (2026-06-22, "see/edit/FORWARD — never a trap"): a body-quality hold is a SOFT
  // caution, not a block. After the RN opens + fixes the flagged section by hand, the held letter
  // must move FORWARD to the doctor — not require a ~$15 re-draft to escape the park. This sends
  // needs_rn_decision -> physician_review (the edge added to case-status-transitions.ts; the backend
  // mirrors the rn_review "send to doctor" assigned-physician guard). The truthful-attestation safety
  // is untouched: sign-off still demands honest answers — it gates on ANSWER CONTENT at the doctor,
  // not on blocking forward progress here. Shown only when a real produced draft exists (otherwise
  // there's nothing to send — re-draft is the only path).
  const sendToDoctor = useMutation({
    mutationFn: () => transitionCaseStatus(c.id, { from: c.status, to: 'physician_review', version: c.version, transitionReason: 'RN resolved body-quality hold — sent to physician for review' }),
    onSuccess: () => void onChanged(),
    onError: (e: unknown) => window.alert(`Could not send to the doctor — ${describeApiError(e)}`),
  });
  function doSendToDoctor() {
    if (!window.confirm('Send this letter to the doctor for review? Do this once the flagged section has been fixed in the editor. The doctor still reviews and signs off before delivery.')) return;
    sendToDoctor.mutate();
  }

  return (
    <Card className="rounded-2xl border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-5 shadow-aegis-card">
      <div className="flex items-center gap-2">
        <svg className="h-5 w-5 flex-none text-amber-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>
        <h2 className="text-base font-semibold text-amber-900">
          {canOpenEditor ? 'Quality check — review before this goes to the doctor' : 'Quality hold — letter held for re-draft'}
        </h2>
      </div>
      <p className="mt-2 text-sm text-amber-900">{message}</p>
      {canOpenEditor ? (
        <p className="mt-1 text-sm text-amber-900">The draft is ready to open — you can fix the flagged section by hand in the editor, or re-draft it.</p>
      ) : null}
      {findings.length > 0 ? (
        <ul className="mt-3 space-y-1.5 rounded-md border border-amber-200 bg-white p-3 text-sm">
          {findings.map((f) => (
            <li key={f.id} className="flex items-start gap-2">
              <span className="mt-0.5 w-4 flex-none text-center font-bold text-red-700" aria-hidden="true">✗</span>
              <span>
                <span className="font-medium text-slate-800">{defectLabel(f.id)}</span>
                {f.section ? <span className="text-slate-600"> — section {f.section}</span> : null}
                {f.detail ? <span className="block text-xs text-slate-600">{f.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {canOpenEditor ? (
          <Button variant="secondary" size="sm" className="border border-amber-600 bg-amber-600 text-white shadow-sm hover:bg-amber-700" onClick={onOpenEditor}>Open letter editor</Button>
        ) : null}
        {canOpenEditor ? (
          <Button
            variant="secondary"
            size="sm"
            className="border border-amber-300 bg-white text-amber-900 shadow-sm hover:bg-amber-50"
            disabled={sendToDoctor.isPending}
            onClick={doSendToDoctor}
          >
            Send to doctor for review
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          className={canOpenEditor ? 'border border-amber-300 bg-white text-amber-900 shadow-sm hover:bg-amber-50' : 'border border-amber-600 bg-amber-600 text-white shadow-sm hover:bg-amber-700'}
          disabled={redraft.isPending}
          onClick={doRedraft}
        >
          Re-draft the letter
        </Button>
      </div>
      <p className="mt-3 text-xs text-amber-800">
        {canOpenEditor
          ? 'Fix the flagged section by hand in the editor (a new version), then Send to doctor for review — the doctor still reviews and signs off before delivery. This is a soft quality caution, not a block: re-draft is optional. Not a diagnosis or records issue.'
          : 'A re-draft re-runs the full draft to fix the flagged section(s). The prior draft is kept for reference. This is a content-quality hold, not a diagnosis or records issue.'}
      </p>
    </Card>
  );
}

export function Gate2HaltPanel({ c, job, onChanged, onOpenEditor }: { readonly c: CaseDetail; readonly job?: DraftJob; readonly onChanged: () => void | Promise<void>; readonly onOpenEditor?: () => void }) {
  const payload: Gate2HaltPayload = (job?.haltPayloadJson as Gate2HaltPayload | null | undefined) ?? {};

  // Body-quality park → a distinct card. When a draft was produced (artifact key present), the hold is
  // ADVISORY/editable (open the editor + fix by hand); otherwise re-draft is the only path. The dx
  // switch/override/proceed options never apply to a content defect.
  if (isBodyQualityHalt(payload)) {
    return <BodyQualityHoldCard c={c} payload={payload} {...(job ? { job } : {})} onChanged={onChanged} {...(onOpenEditor ? { onOpenEditor } : {})} />;
  }

  const message = payload.plainEnglish || payload.operatorMessage || c.operatorMessage || 'The pre-draft verification could not confirm the diagnosis and/or in-service event. Decide how to proceed.';
  const sw = payload.switchProposal ?? null;

  // DX-resolution chooser (#218a). ABSENT/null until the FRN drafter image redeploys → the panel must
  // render exactly as today (the always-present #213 change-dx box). When present:
  //   'needs_clarification' → show dxResolution.note + a row of CLICKABLE candidate buttons, each of
  //                           which re-aims the draft through the SAME #213 changeDx flow (patch chart
  //                           dx → re-draft, reason-gated, ConflictError-retry). The free-type #213 box
  //                           stays only when allowFreeType !== false.
  //   'no_dx'              → today's behavior (real reason + re-run); surface the note if present.
  //   'auto_adopted'       → N/A on the HALT path (auto-adopt PROCEEDS to draft, no halt). The relabel
  //                           note for the proceed path is #218b — OWED, needs a drafter-side report on
  //                           the proceed path (not yet built). Do NOT build it here.
  const dxRes = payload.dxResolution ?? null;
  const showCandidateChooser = dxRes?.mode === 'needs_clarification' && dxRes.candidates.length > 0;
  // The #213 free-type box is ALWAYS present today (no-regression baseline). Suppress it ONLY when the
  // drafter explicitly disallows free typing on a needs_clarification resolution. Every other case —
  // dxResolution absent, no_dx, or allowFreeType true — keeps the box so the RN is never dead-ended.
  const showFreeTypeBox = dxRes === null || dxRes.mode !== 'needs_clarification' || dxRes.allowFreeType !== false;

  const resume = useMutation({
    mutationFn: (rnDecision: RnDecisionInput) => postDraft(c.id, { rnDecision }),
    onSuccess: () => void onChanged(),
    onError: (e: unknown) => window.alert(`Could not resume drafting — ${describeApiError(e)}`),
  });
  const pause = useMutation({
    mutationFn: () => transitionCaseStatus(c.id, { from: c.status, to: 'needs_records', version: c.version }),
    onSuccess: () => void onChanged(),
    onError: (e: unknown) => window.alert(`Could not pause — ${describeApiError(e)}`),
  });
  // CHANGE-DX-AND-RE-DRAFT (Michael Dick 2026-06-29). One mutation that, IN ORDER: (a) persists the new dx onto
  // the CHART via PATCH /cases/:id (the backend syncs claimedConditions[] + invalidates the plan) so the chart
  // and the letter agree, then (b) re-aims the parked draft via postDraft(rnDecision.switchToCondition) (which
  // also writes the DraftDecision audit row). Both the recommended "Switch to {dx}" button AND the always-present
  // free-text input route through here — so neither can leave the chart dx stale (the pre-existing bug: the old
  // doSwitch re-aimed the letter but never patched the chart, so the chart showed the OLD dx while the letter
  // drafted the new one). Optimistic-concurrency 409 → reload + ask the RN to retry (the page's existing pattern).
  const changeDx = useMutation({
    mutationFn: async (vars: { newDx: string; reason: string }) => {
      await patchCase(c.id, { version: c.version, claimedCondition: vars.newDx });
      await postDraft(c.id, { rnDecision: { switchToCondition: vars.newDx, reason: vars.reason } });
    },
    onSuccess: () => void onChanged(),
    onError: async (e: unknown) => {
      if (e instanceof ConflictError) {
        await onChanged();
        window.alert('This case was modified elsewhere — reloaded the latest version. Please retry the diagnosis change.');
        return;
      }
      window.alert(`Could not change the diagnosis & re-draft — ${describeApiError(e)}`);
    },
  });

  function override() {
    const reason = window.prompt('Draft anyway on the claimed condition? Type a brief reason — it is logged and shown in the chart.');
    if (reason === null || reason.trim().length === 0) return;
    resume.mutate({ gate2Override: true, reason: reason.trim() });
  }
  function doSwitch() {
    if (sw === null) return;
    const reason = window.prompt(`Switch the letter to ${sw.dx} and re-draft? Type a brief reason (logged).`) ?? '';
    // Routes through changeDx so the CHART dx is patched too (was the stale-chart bug). Empty reason keeps the
    // prior default ("switch to {dx}") — the recommended-fit button is a deliberate one-click, not free-text.
    changeDx.mutate({ newDx: sw.dx, reason: reason.trim().length > 0 ? reason.trim() : `switch to ${sw.dx}` });
  }
  function doChangeDx() {
    const newDx = dxInput.trim();
    if (newDx.length === 0) return;
    const reason = window.prompt(`Change the diagnosis to ${newDx} and re-draft? Type a brief reason — it is logged and shown in the chart.`);
    if (reason === null || reason.trim().length === 0) return; // deliberate confirm before the ~$15 run (audit + intent)
    changeDx.mutate({ newDx, reason: reason.trim() });
  }
  // Candidate pick (#218a). A one-click on a drafter-surfaced candidate routes through the SAME #213
  // changeDx flow (patch chart dx → re-draft) so the chart can never go stale, with the same reason
  // gate + ConflictError retry. This is the only new dx-mutation entry point; it reuses, not forks.
  function doPickCandidate(candidate: string) {
    const newDx = candidate.trim();
    if (newDx.length === 0) return;
    const reason = window.prompt(`Change the diagnosis to ${newDx} and re-draft? Type a brief reason — it is logged and shown in the chart.`);
    if (reason === null || reason.trim().length === 0) return; // deliberate confirm before the ~$15 run (audit + intent)
    changeDx.mutate({ newDx, reason: reason.trim() });
  }
  function proceed() {
    if (!window.confirm('The diagnosis / records are now present — re-run the draft?')) return;
    resume.mutate({ proceed: true });
  }

  // The free-text dx box is pre-filled with the suggested dx when the gate surfaced one, else empty (the RN
  // types the better-fit dx — e.g. when the drafter buried it in prose with no switchProposal, the Michael Dick
  // case). State lives here so the always-present affordance works whether or not `sw` is present.
  const [dxInput, setDxInput] = useState<string>(sw?.dx ?? '');

  const busy = resume.isPending || pause.isPending || changeDx.isPending;
  // White/outline amber buttons read as clearly-clickable on the amber card (the shared `secondary`
  // gray washes out on amber). The switch (recommended stronger fit) gets the one filled emphasis.
  const amberOutline = 'border border-amber-300 bg-white text-amber-900 shadow-sm hover:bg-amber-50';
  return (
    <Card className="rounded-2xl border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-5 shadow-aegis-card">
      <div className="flex items-center gap-2">
        <svg className="h-5 w-5 flex-none text-amber-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>
        <h2 className="text-base font-semibold text-amber-900">Drafting paused — your decision needed</h2>
      </div>
      <p className="mt-2 text-sm text-amber-900">{message}</p>
      {/* #218a no_dx: the drafter could resolve no diagnosis at all — surface its plain-English note (if
          any) as extra context. The actionable behavior is unchanged from today (override / re-run / pause). */}
      {dxRes?.mode === 'no_dx' && dxRes.note.trim().length > 0 ? (
        <p className="mt-1 text-sm text-amber-900">{dxRes.note}</p>
      ) : null}
      {payload.claimedDxFound || payload.inServiceEventFound ? (
        <ul className="mt-3 space-y-1.5 rounded-md border border-amber-200 bg-white p-3 text-sm">
          {payload.claimedDxFound ? (
            <FindingRow label="Diagnosis of the claimed condition" verdict={payload.claimedDxFound} evidence={payload.claimedDxEvidence} />
          ) : null}
          {payload.inServiceEventFound ? (
            <FindingRow label="In-service event / SC anchor" verdict={payload.inServiceEventFound} evidence={payload.inServiceEventEvidence} />
          ) : null}
        </ul>
      ) : null}
      {sw !== null ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-white p-3 text-sm text-slate-700">
          <span className="font-semibold">Possible stronger fit: </span>
          {sw.plainEnglish || `The records show ${sw.dx}${sw.scAnchor ? ` (anchor: ${sw.scAnchor})` : ''}.${sw.whyMoreViable ? ` ${sw.whyMoreViable}` : ''}`}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {sw !== null ? <Button variant="secondary" size="sm" className="border border-amber-600 bg-amber-600 text-white shadow-sm hover:bg-amber-700" disabled={busy} onClick={doSwitch}>Switch to {sw.dx}</Button> : null}
        <Button variant="secondary" size="sm" className={amberOutline} disabled={busy} onClick={override}>Draft anyway (override)</Button>
        <Button variant="secondary" size="sm" className={amberOutline} disabled={busy} onClick={proceed}>Records are in — re-run</Button>
        {c.status !== 'needs_records' ? <Button variant="ghost" size="sm" className="text-amber-800 hover:bg-amber-100" disabled={busy} onClick={() => pause.mutate()}>Pause to get records</Button> : null}
      </div>
      {/* DX-RESOLUTION CHOOSER (#218a). When the drafter's pre-draft dx-verification returns
          mode 'needs_clarification' it hands back a short list of plausible diagnoses. Surface them as
          one-click buttons (format-matched to the #213 box below): the plain-English note, then a row of
          candidate buttons each re-aiming the draft through the SAME changeDx flow. The RN is never
          dead-ended — the override / re-run / pause actions above and the free-type box below remain. */}
      {showCandidateChooser && dxRes !== null ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-white p-3">
          <p className="block text-sm font-medium text-slate-800">Which diagnosis should the letter argue?</p>
          {dxRes.note.trim().length > 0 ? (
            <p className="mt-0.5 text-xs text-slate-500">{dxRes.note}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {dxRes.candidates.map((candidate) => (
              <Button key={candidate} variant="secondary" size="sm" className={amberOutline} disabled={busy} onClick={() => doPickCandidate(candidate)}>
                {candidate}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">Picking one updates the chart&apos;s claimed condition and re-aims the draft. You&apos;ll confirm with a brief reason (logged).</p>
        </div>
      ) : null}
      {/* ALWAYS-PRESENT inline dx change (Michael Dick 2026-06-29). The drafter sometimes buries the better-fit
          diagnosis in prose with NO switchProposal — leaving the RN no inline way to re-aim the letter (they had
          to leave the page). This box is always here: pre-filled with the suggested dx when present, else
          free-text. "Change diagnosis & re-draft" patches the chart dx AND re-runs the draft (changeDx). The
          #218a chooser above does NOT replace it — it stays unless the drafter explicitly disallows free typing
          (allowFreeType === false on a needs_clarification resolution), so the no-regression default is preserved. */}
      {showFreeTypeBox ? (
      <div className="mt-4 rounded-md border border-amber-200 bg-white p-3">
        <label htmlFor="gate2-dx-change" className="block text-sm font-medium text-slate-800">Change the diagnosis &amp; re-draft</label>
        <p className="mt-0.5 text-xs text-slate-500">Type the condition the letter should argue (e.g. &ldquo;osteoarthritis&rdquo;). This updates the chart&apos;s claimed condition and re-aims the draft. You&apos;ll confirm with a brief reason (logged).</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            id="gate2-dx-change"
            type="text"
            value={dxInput}
            onChange={(e) => setDxInput(e.target.value)}
            placeholder="New diagnosis"
            disabled={busy}
            className="min-w-[14rem] flex-1 rounded-md border border-amber-300 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:bg-slate-50"
          />
          <Button variant="secondary" size="sm" className={amberOutline} disabled={busy || dxInput.trim().length === 0} onClick={doChangeDx}>Change diagnosis &amp; re-draft</Button>
        </div>
      </div>
      ) : null}
      <p className="mt-3 text-xs text-amber-800">Every choice is logged and shown in the chart&apos;s Decisions &amp; overrides panel.</p>
    </Card>
  );
}
