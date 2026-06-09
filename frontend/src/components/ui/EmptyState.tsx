import { FileText } from 'lucide-react';

// Shared empty-state, in the Aegis palette. Sits inside a TabSection (which owns the border), so this no
// longer draws its own box — no more double-bordered empty states across tabs.
export function EmptyState({ title = 'Nothing here yet', message }: { readonly title?: string; readonly message: string }) {
  return (
    <div className="flex flex-col items-center rounded-2xl bg-foam px-6 py-12 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-mistSoft text-navy">
        <FileText size={20} strokeWidth={1.75} />
      </div>
      <h3 className="text-sm font-semibold text-navyDeep">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-steel">{message}</p>
    </div>
  );
}
