import { useEffect } from 'react';
import { Button } from './ui/Button';

// Expand-to-read modal for proposed-revision previews (Dr. Kasky 2026-06-26). A reusable ~2/3-screen
// window for any revision proposal (surgical / guided revision / citation enricher), in both the RN and
// physician letter views, so a cramped preview box can be read comfortably and acted on. Accept / Decline
// act on the SAME handlers the inline panel uses; Close just dismisses without deciding. Backdrop +
// Escape + stopPropagation mirror the other app modals.
export function RevisionPreviewModal({
  title, preview, subtitle, applying = false, acceptLabel = 'Accept', declineLabel = 'Decline',
  onAccept, onDecline, onClose,
}: {
  readonly title: string;
  readonly preview: string;
  readonly subtitle?: string | null;
  readonly applying?: boolean;
  readonly acceptLabel?: string;
  readonly declineLabel?: string;
  readonly onAccept?: (() => void | Promise<void>) | null;
  readonly onDecline?: (() => void) | null;
  readonly onClose: () => void;
}) {
  // Escape closes (without deciding). Bound once while the modal is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-6" onClick={onClose}>
      {/* ~2/3 of the screen, never full-screen (Dr. Kasky). */}
      <div className="flex h-[82vh] w-[66vw] max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
          </div>
          <button type="button" className="text-slate-400 hover:text-slate-600" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="flex-1 overflow-auto whitespace-pre-wrap px-6 py-5 font-['Times_New_Roman',Times,serif] text-base leading-relaxed text-slate-800">
          {preview}
        </div>
        <div className="flex items-center gap-2 border-t border-slate-200 px-5 py-3">
          {onAccept ? <Button type="button" variant="primary" loading={applying} disabled={applying} onClick={() => void onAccept()}>{acceptLabel}</Button> : null}
          {onDecline ? <Button type="button" variant="secondary" disabled={applying} onClick={onDecline}>{declineLabel}</Button> : null}
          <Button type="button" variant="secondary" disabled={applying} onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
