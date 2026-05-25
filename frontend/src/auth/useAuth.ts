import { useContext } from 'react';
import { AuthContext } from './AuthProvider';

export { derivePrimaryRole } from './AuthProvider';
export type { AuthContextValue, AuthUser } from './AuthProvider';

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return context;
}
