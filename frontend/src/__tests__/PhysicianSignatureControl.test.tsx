import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicianSignatureControl } from '../components/PhysicianSignatureControl';
import { downloadPhysicianSignature, uploadAndAttachPhysicianSignature, type PhysicianPublic } from '../api/physicians';

vi.mock('../api/physicians', async () => {
  const actual = await vi.importActual<typeof import('../api/physicians')>('../api/physicians');
  return { ...actual, uploadAndAttachPhysicianSignature: vi.fn(), downloadPhysicianSignature: vi.fn() };
});

const uploadMock = vi.mocked(uploadAndAttachPhysicianSignature);
const downloadMock = vi.mocked(downloadPhysicianSignature);

const physician: PhysicianPublic = {
  id: 'physician-1', cognitoSub: null, fullName: 'Dr. Test Physician', npi: '1234567890',
  specialty: 'Internal Medicine', medicalLicense: 'AZ-12345', email: 'doctor@example.com', phone: null,
  hasSignature: true, hasCredentialBlock: true, boardName: 'American Board of Internal Medicine', boardAbbreviation: 'ABIM', licenseState: 'Arizona', licenseNumber: '12345',
  active: true, createdAt: '2026-05-25T12:00:00.000Z', updatedAt: '2026-05-25T12:00:00.000Z', version: 1,
};

function renderControl(input: PhysicianPublic = physician) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><PhysicianSignatureControl physician={input} /></QueryClientProvider>);
}

describe('PhysicianSignatureControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadMock.mockResolvedValue({ data: { ...physician, hasSignature: true } });
    downloadMock.mockResolvedValue({ data: { downloadUrl: 'https://example.com/signature.png', expiresInSeconds: 300 } });
  });

  it('rejects non-PNG files before upload', async () => {
    renderControl();
    const input = screen.getByLabelText('Upload PNG');
    fireEvent.change(input, { target: { files: [new File(['x'], 'signature.jpg', { type: 'image/jpeg' })] } });
    expect(await screen.findByText('Signature must be a PNG file.')).toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('uploads a PNG signature file', async () => {
    renderControl();
    const input = screen.getByLabelText('Upload PNG');
    const file = new File(['png-bytes'], 'signature.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => { expect(uploadMock).toHaveBeenCalledWith('physician-1', file); });
    expect(await screen.findByText('Signature uploaded.')).toBeInTheDocument();
  });

  it('loads and renders signature preview', async () => {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => { expect(downloadMock).toHaveBeenCalledWith('physician-1'); });
    const image = await screen.findByAltText('Dr. Test Physician signature preview');
    expect(image).toHaveAttribute('src', 'https://example.com/signature.png');
  });

  it('disables preview when signature is missing', () => {
    renderControl({ ...physician, hasSignature: false });
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(screen.getByText('Missing signature')).toBeInTheDocument();
  });
});
