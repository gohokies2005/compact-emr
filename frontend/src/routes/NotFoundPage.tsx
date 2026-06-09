import { Link } from 'react-router-dom';
import { AppShell } from '../layout/AppShell';
import { Button } from '../components/ui/Button';
export function NotFoundPage() { return <AppShell><div className="rounded-2xl border border-aegis bg-ivory p-8 shadow-aegis-card"><h1 className="text-2xl font-semibold text-navyDeep">404 — Not found</h1><p className="mt-2 text-sm text-slate-500">This route does not exist in Compact EMR.</p><Link to="/" className="mt-6 inline-block"><Button>Back to home</Button></Link></div></AppShell>; }
