import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseAssignmentPanel } from '../components/CaseAssignmentPanel';
import { assignCasePhysician, assignCaseRn, getCase } from '../api/cases';
import { ConflictError } from '../api/client';
import { listPhysicians } from '../api/physicians';
import { listUsers } from '../api/users';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, assignCasePhysician: vi.fn(), assignCaseRn: vi.fn(), getCase: vi.fn() };
});
vi.mock('../api/physicians', async () => {
  const actual = await vi.importActual<typeof import('../api/physicians')>('../api/physicians');
  return { ...actual, listPhysicians: vi.fn() };
});
vi.mock('../api/users', async () => {
  const actual = await vi.importActual<typeof import('../api/users')>('../api/users');
  return { ...actual, listUsers: vi.fn() };
});

const assignMock = vi.mocked(assignCasePhysician);
const assignRnMock = vi.mocked(assignCaseRn);
const getCaseMock = vi.mocked(getCase);
const listPhysiciansMock = vi.mocked(listPhysicians);
const listUsersMock = vi.mocked(listUsers);

function caseEnvelope(version: number) {
  return { data: { id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Sleep apnea', claimType: 'supplemental', status: 'physician_review', version, currentVersion: 1, assignedPhysicianId: null, assignedRnId: null, refundEligible: false, createdAt: '2026-05-25T12:00:00.000Z', updatedAt: '2026-05-25T12:00:00.000Z' } } as unknown as Awaited<ReturnType<typeof getCase>>;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><CaseAssignmentPanel caseId="CASE-1" version={3} assignedPhysician={null} assignedRn={null} /></QueryClientProvider>);
}

describe('CaseAssignmentPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPhysiciansMock.mockResolvedValue({
      data: [{ id: 'physician-1', cognitoSub: 'sub-1', fullName: 'Dr. Test Physician', npi: '1234567890', specialty: 'Internal Medicine', medicalLicense: 'AZ-123', email: 'doctor@example.com', phone: null, hasSignature: true, hasCredentialBlock: true, boardName: 'American Board of Internal Medicine', boardAbbreviation: 'ABIM', licenseState: 'Arizona', licenseNumber: '123', active: true, createdAt: '2026-05-25T12:00:00.000Z', updatedAt: '2026-05-25T12:00:00.000Z', version: 1 }],
    });
    assignMock.mockResolvedValue({
      data: { id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Sleep apnea', claimType: 'supplemental', status: 'physician_review', version: 4, currentVersion: 1, assignedPhysicianId: 'physician-1', assignedRnId: null, refundEligible: false, createdAt: '2026-05-25T12:00:00.000Z', updatedAt: '2026-05-25T12:00:00.000Z' },
    });
    assignRnMock.mockResolvedValue({
      data: { id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Sleep apnea', claimType: 'supplemental', status: 'physician_review', version: 4, currentVersion: 1, assignedPhysicianId: null, assignedRnId: 'user-rn', refundEligible: false, createdAt: '2026-05-25T12:00:00.000Z', updatedAt: '2026-05-25T12:00:00.000Z' },
    });
    listUsersMock.mockResolvedValue({ data: [{ id: 'user-rn', email: 'rn@example.com', name: 'RN One', active: true, roles: ['ops_staff'], version: 1 }] });
  });

  it('loads physicians and assigns the selected physician', async () => {
    renderPanel();
    // Wait for the physicians query to populate the <option> before selecting it.
    await screen.findByRole('option', { name: 'Dr. Test Physician · Internal Medicine' });
    const select = screen.getByLabelText('Assign or reassign physician');
    fireEvent.change(select, { target: { value: 'physician-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign physician' }));
    await waitFor(() => { expect(assignMock).toHaveBeenCalledWith('CASE-1', { physicianId: 'physician-1', version: 3 }); });
  });

  it('loads RN liaisons and assigns the selected RN', async () => {
    renderPanel();
    await screen.findByRole('option', { name: 'rn@example.com' });
    const rnSelect = screen.getByLabelText('Assign or reassign RN');
    expect(rnSelect).not.toBeDisabled();
    fireEvent.change(rnSelect, { target: { value: 'user-rn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign RN' }));
    await waitFor(() => { expect(assignRnMock).toHaveBeenCalledWith('CASE-1', { rnUserId: 'user-rn', version: 3 }); });
  });

  // Root cause: a background poll bumps the case version between page-load and the click, so the
  // first assign sends a stale version and 409s. The panel must refetch the fresh version and retry
  // ONCE — the routine bump must never surface to the RN.
  it('on a first-attempt 409, refetches the fresh version and retries once, succeeding silently', async () => {
    // First call 409s (stale version 3); refetch returns version 7; retry succeeds with 7.
    assignMock
      .mockRejectedValueOnce(new ConflictError({ reason: 'stale_version' }, 'Case version is stale', 'conflict'))
      .mockResolvedValueOnce(caseEnvelope(8) as unknown as Awaited<ReturnType<typeof assignCasePhysician>>);
    getCaseMock.mockResolvedValue(caseEnvelope(7));

    renderPanel();
    await screen.findByRole('option', { name: 'Dr. Test Physician · Internal Medicine' });
    fireEvent.change(screen.getByLabelText('Assign or reassign physician'), { target: { value: 'physician-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign physician' }));

    // Two attempts: stale prop version 3, then fresh server version 7.
    await waitFor(() => { expect(assignMock).toHaveBeenCalledTimes(2); });
    expect(assignMock).toHaveBeenNthCalledWith(1, 'CASE-1', { physicianId: 'physician-1', version: 3 });
    expect(assignMock).toHaveBeenNthCalledWith(2, 'CASE-1', { physicianId: 'physician-1', version: 7 });
    expect(getCaseMock).toHaveBeenCalledTimes(1);
    // Success path — no "updated by someone else" error shown.
    await screen.findByText('Physician assignment updated.');
    expect(screen.queryByText(/updated by someone else/i)).toBeNull();
  });

  it('surfaces the conflict error only when BOTH attempts 409 (a genuine race)', async () => {
    assignMock.mockRejectedValue(new ConflictError({ reason: 'stale_version' }, 'Case version is stale', 'conflict'));
    getCaseMock.mockResolvedValue(caseEnvelope(7));

    renderPanel();
    await screen.findByRole('option', { name: 'Dr. Test Physician · Internal Medicine' });
    fireEvent.change(screen.getByLabelText('Assign or reassign physician'), { target: { value: 'physician-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign physician' }));

    await screen.findByText(/updated by someone else/i);
    // Exactly one retry — never a loop.
    expect(assignMock).toHaveBeenCalledTimes(2);
    expect(getCaseMock).toHaveBeenCalledTimes(1);
  });
});
