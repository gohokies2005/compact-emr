import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMenu } from '../layout/UserMenu';
import { getMe } from '../api/users';
import { getPhysicianMe } from '../api/physicians';
import type { Role } from '../types/prisma';

/**
 * P3 identity cluster: avatar (image or silhouette fallback) + [name / email / role chip],
 * sourced from /users/me (+ /physicians/me for the credentialed physician name), degrading to
 * email-only when the lookup 404s. Chip labels are the human forms (Ryan 2026-06-11).
 */

interface MockUser { sub: string; email: string; role: Role; roles: Role[] }
let mockUser: MockUser | null = null;

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ user: mockUser, role: mockUser?.role ?? null, loading: false, signOut: vi.fn() }),
}));
vi.mock('../api/messaging', () => ({ useHasQueryClient: () => true }));
vi.mock('../components/InstallAppButton', () => ({ InstallAppButton: () => null }));
vi.mock('../api/users', async () => {
  const actual = await vi.importActual<typeof import('../api/users')>('../api/users');
  return { ...actual, getMe: vi.fn() };
});
vi.mock('../api/physicians', async () => {
  const actual = await vi.importActual<typeof import('../api/physicians')>('../api/physicians');
  return { ...actual, getPhysicianMe: vi.fn() };
});

const getMeMock = vi.mocked(getMe);
const getPhysicianMeMock = vi.mocked(getPhysicianMe);

function renderMenu(user: MockUser) {
  mockUser = user;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <UserMenu />
    </QueryClientProvider>,
  );
}

const STAFF: MockUser = { sub: 'rn-sub', email: 'rn@x.test', role: 'ops_staff', roles: ['ops_staff'] };
const DOC: MockUser = { sub: 'doc-sub', email: 'doc@x.test', role: 'physician', roles: ['physician'] };

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = null;
  getMeMock.mockResolvedValue({ data: { id: 'U-1', email: 'rn@x.test', name: 'Riley Staffer, RN', roles: ['ops_staff'], avatarUrl: null } });
  getPhysicianMeMock.mockResolvedValue({ data: { id: 'PH-1', fullName: 'Jane Smith, DO', credentials: 'DO' } });
});

describe('UserMenu identity cluster', () => {
  it('staff: renders name + email + "Operations staff" chip + silhouette fallback (no avatar set)', async () => {
    renderMenu(STAFF);
    expect(await screen.findByText('Riley Staffer, RN')).toBeInTheDocument();
    expect(screen.getByText('rn@x.test')).toBeInTheDocument();
    expect(screen.getByText('Operations staff')).toBeInTheDocument();
    expect(screen.getByTestId('avatar-fallback')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /avatar$/i })).not.toBeInTheDocument();
  });

  it('renders the round avatar image (not the fallback) when avatarUrl is set', async () => {
    getMeMock.mockResolvedValue({ data: { id: 'U-1', email: 'rn@x.test', name: 'Riley Staffer, RN', roles: ['ops_staff'], avatarUrl: 'https://signed.example/a.png' } });
    renderMenu(STAFF);
    const img = await screen.findByAltText('Riley Staffer, RN avatar');
    expect(img).toHaveAttribute('src', 'https://signed.example/a.png');
    expect(screen.queryByTestId('avatar-fallback')).not.toBeInTheDocument();
  });

  it('physician: shows the credentialed Physician-row name and the "Physician" chip', async () => {
    renderMenu(DOC);
    expect(await screen.findByText('Jane Smith, DO')).toBeInTheDocument();
    expect(screen.getByText('Physician')).toBeInTheDocument();
  });

  it('admin chip reads "Admin"', async () => {
    getMeMock.mockResolvedValue({ data: { id: 'U-A', email: 'admin@x.test', name: 'Ada Min', roles: ['admin'], avatarUrl: null } });
    renderMenu({ sub: 'a-sub', email: 'admin@x.test', role: 'admin', roles: ['admin'] });
    expect(await screen.findByText('Admin')).toBeInTheDocument();
  });

  it('degrades to email-only when /users/me 404s (Cognito-only login) — never crashes', async () => {
    getMeMock.mockRejectedValue(new Error('404 not_found'));
    renderMenu(STAFF);
    expect(await screen.findByText('rn@x.test')).toBeInTheDocument();
    expect(screen.getByText('Operations staff')).toBeInTheDocument();
    expect(screen.queryByText('Riley Staffer, RN')).not.toBeInTheDocument();
    // Upload needs the AppUser id — the avatar button stays disabled without it.
    expect(screen.getByRole('button', { name: 'Change your avatar' })).toBeDisabled();
  });

  it('clicking the avatar opens the self-service upload modal', async () => {
    renderMenu(STAFF);
    await screen.findByText('Riley Staffer, RN');
    await userEvent.click(screen.getByRole('button', { name: 'Change your avatar' }));
    expect(await screen.findByRole('dialog', { name: 'Change your avatar' })).toBeInTheDocument();
    expect(screen.getByText(/PNG, JPEG, or WebP up to 2 MB/)).toBeInTheDocument();
  });
});
