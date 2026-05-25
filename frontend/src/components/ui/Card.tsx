import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function Card({ children, className }: { readonly children: ReactNode; readonly className?: string }) { return <section className={twMerge(clsx('rounded-lg border border-slate-200 bg-white p-6 shadow-sm', className))}>{children}</section>; }
