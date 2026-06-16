import { useState, type ReactNode } from 'react';

/**
 * Disclosure — the ONE expander style for the app (2026-06-16). The prior hand-rolled expanders
 * drifted across ~4 sites (different glyphs ▼/▾, sizes, colors). This standardizes the trigger:
 * same text size/color, same caret pair (▾ collapsed / ▴ open), same spacing — so "Details",
 * "Strategy checks (5)", "Why not these anchors", etc. all look and behave identically.
 *
 * Uncontrolled by default (own state); pass `defaultOpen` to start expanded. The label is the
 * collapsed text; `openLabel` overrides it when expanded (defaults to the same label).
 */
export function Disclosure({
  label,
  openLabel,
  defaultOpen = false,
  children,
  className,
}: {
  readonly label: string;
  readonly openLabel?: string;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-xs text-slate-500 hover:text-slate-700"
      >
        {open ? (openLabel ?? label) : label} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}
