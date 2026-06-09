import { clsx } from 'clsx';

export interface TabItem<T extends string> { readonly id: T; readonly label: string; }

// Shared Aegis pill-tab bar — soft tabs on a misty strip; the active tab carries a brass inset
// underline that echoes the login wordmark bar (board-2 look). Generic over the tab id type.
export function TabBar<T extends string>({ tabs, active, onChange, className }: { readonly tabs: readonly TabItem<T>[]; readonly active: T; readonly onChange: (id: T) => void; readonly className?: string }) {
  return <div role="tablist" className={clsx('flex border-b border-aegis text-sm', className)}>{tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={active === t.id} className={clsx('rounded-t-xl px-4 py-2.5 text-sm font-medium transition-colors', active === t.id ? 'bg-ivory text-navyDeep shadow-[inset_0_-2px_0_var(--aegis-brass)]' : 'text-steel hover:bg-mistSoft hover:text-navyDeep')} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}
