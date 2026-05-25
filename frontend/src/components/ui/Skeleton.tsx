import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function Skeleton({ className }: { readonly className?: string }) { return <div className={twMerge(clsx('animate-pulse rounded-md bg-slate-200', className))} />; }
