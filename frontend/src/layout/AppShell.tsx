import type { ReactNode } from 'react';
import { TopNav } from './TopNav';
import { BuildStatusFooter } from '../components/BuildStatusFooter';
export function AppShell({ children }: { readonly children: ReactNode }) { return <div className="min-h-screen bg-foam"><TopNav /><main className="mx-auto max-w-7xl px-6 py-8">{children}</main><BuildStatusFooter /></div>; }
