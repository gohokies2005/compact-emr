import { LogOut } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useAuth } from '../auth/useAuth';
import { RoleBadge } from './RoleBadge';
export function UserMenu() { const { user, signOut } = useAuth(); if (!user) return null; return <div className="flex items-center gap-3"><div className="text-right"><div className="text-sm font-medium text-slate-900">{user.email}</div><div className="mt-1 flex justify-end"><RoleBadge role={user.role} /></div></div><Button variant="ghost" size="sm" onClick={() => { void signOut(); }}><LogOut size={16} /> Sign out</Button></div>; }
