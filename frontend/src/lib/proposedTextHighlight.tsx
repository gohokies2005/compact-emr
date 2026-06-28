import type { ReactNode } from 'react';

// Render a revision PREVIEW (the full resulting letter text) with the FIRST occurrence of the
// proposed/changed text wrapped in a transient highlight <mark>, so the reviewer can instantly spot
// what the edit changed (Item 3, 2026-06-28). PREVIEW-ONLY by design: this affordance lives only on the
// proposal-preview surfaces (the surgical-edit box + its expand modal, Guided Revision). Once the edit is
// applied the letter body re-renders from PLAIN text in LetterEditor — the highlight is never persisted
// into the letter. Fail-open: when `highlight` is empty, or is not found verbatim in `preview` (e.g. a
// proposal the renderer padded/normalized differently, or a multi-span edit), the preview renders plain —
// never an error, never a wrong span. We match the TRIMMED proposed text because the structured proposal's
// new_text often carries surrounding whitespace the assembled preview normalizes away.
export function renderProposedPreview(preview: string, highlight: string | null | undefined): ReactNode {
  const needle = (highlight ?? '').trim();
  if (needle.length === 0) return preview;
  const idx = preview.indexOf(needle);
  if (idx < 0) return preview;
  const before = preview.slice(0, idx);
  const match = preview.slice(idx, idx + needle.length);
  const after = preview.slice(idx + needle.length);
  return (
    <>
      {before}
      <mark className="rounded bg-amber-200/70 px-0.5 text-slate-900">{match}</mark>
      {after}
    </>
  );
}
