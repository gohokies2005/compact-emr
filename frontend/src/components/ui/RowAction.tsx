import type { ButtonHTMLAttributes } from 'react';
import { clsx } from 'clsx';

// One inline text-action style for every tab (Edit, Delete, View letter, Re-run OCR, Resolve) — replaces
// the 3 different action colors (and the indigo leak). navy default, rose for destructive.
export function RowAction({ kind = 'default', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { readonly kind?: 'default' | 'danger' }) {
  return (
    <button
      type="button"
      className={clsx(
        'text-xs font-medium transition-colors disabled:opacity-50',
        kind === 'danger' ? 'text-rose-600 hover:text-rose-700' : 'text-navy hover:text-navyDeep',
        className,
      )}
      {...props}
    />
  );
}
