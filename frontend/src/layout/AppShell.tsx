import type { ReactNode } from 'react';
import { TopNav } from './TopNav';
export function AppShell({ children }: { readonly children: ReactNode }) { return <div className="min-h-screen bg-slate-50"><TopNav /><main className="mx-auto max-w-7xl px-6 py-8">{children}</main></div>; }
