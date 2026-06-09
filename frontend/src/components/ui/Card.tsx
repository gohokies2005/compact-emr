import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function Card({ children, className }: { readonly children: ReactNode; readonly className?: string }) { return <section className={twMerge(clsx('rounded-2xl border border-aegis bg-ivory p-6 shadow-aegis-card transition-all duration-200 ease-out', className))}>{children}</section>; }
