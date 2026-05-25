import { AppShell } from '../../layout/AppShell';
import { EmptyState } from '../../components/ui/EmptyState';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';

export function PReviewPage() { return <AppShell><div className="mb-8 flex items-center justify-between"><div><h1 className="text-2xl font-semibold text-slate-900">Physician review</h1><p className="mt-2 text-sm text-slate-500">Phase 2 placeholder.</p></div><Link to="/p/queue"><Button variant="secondary">Back to queue</Button></Link></div><EmptyState message="This page ships in Phase 4 (placeholder)." /></AppShell>; }
