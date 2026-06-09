import { clsx } from 'clsx';

export interface TabItem<T extends string> { readonly id: T; readonly label: string; }

// Shared tab bar matching the inline tab style used on VeteranChart (active = indigo underline).
export function TabBar<T extends string>({ tabs, active, onChange, className }: { readonly tabs: readonly TabItem<T>[]; readonly active: T; readonly onChange: (id: T) => void; readonly className?: string }) {
  return <div role="tablist" className={clsx('flex border-b border-slate-200 text-sm', className)}>{tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={active === t.id} className={clsx('px-4 py-3', active === t.id ? 'border-b-2 border-navy text-navyDeep' : 'text-steel hover:text-navyDeep')} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}
