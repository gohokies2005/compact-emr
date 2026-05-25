import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'destructive' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

const variantClasses: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600',
  secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200 focus:ring-slate-400',
  destructive: 'bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100 focus:ring-slate-400'
};
const sizeClasses: Record<Size, string> = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-base' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { readonly variant?: Variant; readonly size?: Size; readonly loading?: boolean; readonly children: ReactNode; }
export function Button({ variant = 'primary', size = 'md', loading = false, disabled, className, children, ...props }: ButtonProps) {
  return <button className={twMerge(clsx('inline-flex items-center justify-center gap-2 rounded-md font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60', variantClasses[variant], sizeClasses[size], className))} disabled={disabled || loading} {...props}>{loading ? <Spinner small /> : null}{children}</button>;
}
