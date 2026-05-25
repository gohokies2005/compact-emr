import { useParams } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { EmptyState } from '../../components/ui/EmptyState';

// Placeholder route target wired in Phase 4B-1 so /cases/:id navigation does not 404.
// The full Case Detail page ships in Phase 4B-4.
export function CaseDetailPage() {
  const { id } = useParams();
  return <AppShell><EmptyState title={`Case ${id ?? ''}`} message="Case detail ships in Phase 4B-4." /></AppShell>;
}
