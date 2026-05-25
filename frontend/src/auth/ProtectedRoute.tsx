import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Role } from '../types/prisma';
import { useAuth } from './useAuth';
import { SignInScreen } from './SignInScreen';
import { Spinner } from '../components/ui/Spinner';

export function ProtectedRoute({ children, requiredRole }: { readonly children: ReactNode; readonly requiredRole: readonly Role[] }) {
  const { user, loading, role } = useAuth();
  if (loading) return <div className="flex min-h-screen items-center justify-center"><Spinner label="Loading secure session" /></div>;
  if (!user || !role) return <SignInScreen />;
  if (!requiredRole.includes(role)) return <Navigate to="/403" replace />;
  return <>{children}</>;
}
