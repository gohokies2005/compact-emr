import { clsx } from 'clsx';

export interface TabItem<T extends string> { readonly id: T; readonly label: string; }

// Shared Aegis pill-tab bar — soft tabs on a misty strip; the active tab carries a brass inset
// underline that echoes the login wordmark bar (board-2 look). Generic over the tab id type.
// STICKY (UI sweep P2a, Ryan item 12): the bar pins to the top of the scroll parent so long tab
// content scrolls UNDER it — opaque bg-ivory so content isn't visible through the gap, z-10 so
// panel content never paints over it. One change covers every page that mounts TabBar.
export function TabBar<T extends string>({ tabs, active, onChange, className }: { readonly tabs: readonly TabItem<T>[]; readonly active: T; readonly onChange: (id: T) => void; readonly className?: string }) {
  // One-line fit (Ryan 2026-06-12): tighter padding + slightly smaller text so a full claim tab set
  // (11 tabs) fits on a single row; overflow-x-auto + nowrap means a narrow viewport scrolls
  // horizontally rather than wrapping a lone tab onto its own ugly second line.
  return <div role="tablist" className={clsx('sticky top-0 z-10 flex overflow-x-auto border-b border-aegis bg-ivory text-sm', className)}>{tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={active === t.id} className={clsx('shrink-0 whitespace-nowrap rounded-t-xl px-2.5 py-2 text-[13px] font-medium transition-colors', active === t.id ? 'bg-ivory text-navyDeep shadow-[inset_0_-2px_0_var(--aegis-brass)]' : 'text-steel hover:bg-mistSoft hover:text-navyDeep')} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}
