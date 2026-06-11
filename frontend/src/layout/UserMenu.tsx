import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../components/ui/Button';
import { AvatarCircle } from '../components/ui/AvatarCircle';
import { InstallAppButton } from '../components/InstallAppButton';
import { useAuth } from '../auth/useAuth';
import { useHasQueryClient } from '../api/messaging';
import { getMe } from '../api/users';
import { getPhysicianMe } from '../api/physicians';
import { RoleBadge } from './RoleBadge';
import { AvatarUploadModal } from './AvatarUploadModal';
import type { Role } from '../types/prisma';

/**
 * TopNav identity cluster (P3, UI sweep 2026-06-11): [avatar circle] [full name + credentials /
 * email / role chip] for ALL roles. Names come from /users/me (the JWT carries no name —
 * AuthProvider); a physician's credentialed display name comes from /physicians/me. Both queries
 * degrade to the email-only stack on 404/failure (e.g. a Cognito-only admin with no AppUser row)
 * — the nav must never crash. Clicking the avatar opens the self-service upload modal (Ryan's
 * P3 decision: modal, not a /profile page).
 */
function IdentityCluster({ email, role }: { readonly email: string; readonly role: Role }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const meQuery = useQuery({ queryKey: ['users', 'me'], queryFn: getMe, retry: false, staleTime: 60_000 });
  const physicianMeQuery = useQuery({
    queryKey: ['physicians', 'me'],
    queryFn: getPhysicianMe,
    retry: false,
    staleTime: 60_000,
    enabled: role === 'physician',
  });
  const me = meQuery.data?.data ?? null;
  // Physicians show the credentialed Physician-row name ("Jane Smith, DO"); staff show AppUser.name.
  const displayName = (role === 'physician' ? physicianMeQuery.data?.data.fullName : null) ?? me?.name ?? null;
  return (
    <>
      <button
        type="button"
        aria-label="Change your avatar"
        title="Change your avatar"
        className="shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:cursor-default"
        onClick={() => setUploadOpen(true)}
        disabled={me === null}
      >
        <AvatarCircle url={me?.avatarUrl ?? null} name={displayName ?? email} size={40} />
      </button>
      <div className="text-right">
        {displayName ? <div className="text-sm font-medium text-slate-900">{displayName}</div> : null}
        <div className={displayName ? 'text-xs text-slate-500' : 'text-sm font-medium text-slate-900'}>{email}</div>
        <div className="mt-1 flex justify-end">
          <RoleBadge role={role} />
        </div>
      </div>
      {uploadOpen && me !== null ? <AvatarUploadModal userId={me.id} onClose={() => setUploadOpen(false)} /> : null}
    </>
  );
}

export function UserMenu() {
  const { user, signOut } = useAuth();
  // Same provider-less guard as TopNav's InboxBadge: a unit test rendering without a QueryClient
  // gets the static email-only cluster instead of a crash.
  const hasClient = useHasQueryClient();
  if (!user) return null;
  return (
    <div className="flex items-center gap-3">
      <InstallAppButton />
      {hasClient ? (
        <IdentityCluster email={user.email} role={user.role} />
      ) : (
        <>
          <AvatarCircle name={user.email} size={40} />
          <div className="text-right">
            <div className="text-sm font-medium text-slate-900">{user.email}</div>
            <div className="mt-1 flex justify-end">
              <RoleBadge role={user.role} />
            </div>
          </div>
        </>
      )}
      <Button variant="ghost" size="sm" onClick={() => { void signOut(); }}>
        <LogOut size={16} /> Sign out
      </Button>
    </div>
  );
}
