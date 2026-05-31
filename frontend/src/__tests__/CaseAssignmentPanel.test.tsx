import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseAssignmentPanel } from '../components/CaseAssignmentPanel';
import { assignCasePhysician } from '../api/cases';
import { listPhysicians } from '../api/physicians';

vi.mock('../api/cases', async () => {
  const actual = await vi.importActual<typeof import('../api/cases')>('../api/cases');
  return { ...actual, assignCasePhysician: vi.fn() };
});
vi.mock('../api/physicians', async () => {
  const actual = await vi.importActual<typeof import('../api/physicians')>('../api/physicians');
  return { ...actual, listPhysicians: vi.fn() };
});

const assignMock = vi.mocked(assignCasePhysician);
const listPhysiciansMock = vi.mocked(listPhysicians);

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><CaseAssignmentPanel caseId="CASE-1" version={3} assignedPhysician={null} assignedRn={null} /></QueryClientProvider>);
}

describe('CaseAssignmentPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPhysiciansMock.mockResolvedValue({
      data: [{ id: 'physician-1', cognitoSub: 'sub-1', fullName: 'Dr. Test Physician', npi: '1234567890', specialty: 'Internal Medicine', medicalLicense: 'AZ-123', email: 'doctor@example.com', phone: null, hasSignature: true, active: true, createdAt: '2026-05-25T12:00:00.000Z', updatedAt: '2026-05-25T12:00:00.000Z', version: 1 }],
    });
    assignMock.mockResolvedValue({
      data: { id: 'CASE-1', veteranId: 'VET-1', claimedCondition: 'Sleep apnea', claimType: 'supplemental', status: 'physician_review', version: 4, currentVersion: 1, assignedPhysicianId: 'physician-1', refundEligible: false, createdAt: '2026-05-25T12:00:00.000Z', updatedAt: '2026-05-25T12:00:00.000Z' },
    });
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

  it('shows the disabled RN picker placeholder', () => {
    renderPanel();
    expect(screen.getByLabelText('Assign or reassign RN')).toBeDisabled();
    expect(screen.getByText('The users-list endpoint is not available yet. This control is intentionally disabled.')).toBeInTheDocument();
  });
});
