import { describe, expect, it } from 'vitest';
import type { AppDb, PhysicianRecord } from '../services/db-types.js';
import { isAssignedPhysicianForCase, resolveCurrentPhysician } from '../services/physician-resolver.js';

function buildPhysician(overrides: Partial<PhysicianRecord> = {}): PhysicianRecord {
  const now = new Date('2026-05-26T00:00:00Z');
  return {
    id: 'phys-001',
    cognitoSub: 'cog-abc-123',
    fullName: 'Dr. Jane Smith, DO',
    npi: '1234567890',
    specialty: 'Family Medicine',
    medicalLicense: 'NV-DO2996',
    email: 'jane@example.test',
    phone: null,
    signatureImageS3Key: null,
    credentialBlockJson: null,
    active: true,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

function buildDb(physiciansByCognitoSub: Record<string, PhysicianRecord>): AppDb {
  return {
    physician: {
      findUnique: async (args: unknown) => {
        const where = (args as { where?: { cognitoSub?: string } }).where;
        if (!where?.cognitoSub) return null;
        return physiciansByCognitoSub[where.cognitoSub] ?? null;
      },
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => buildPhysician(),
      update: async () => buildPhysician(),
    },
    // Stubs for the rest of AppDb (not exercised here)
    veteran: {} as never,
    activityLog: {} as never,
    case: {} as never,
    draftJob: {} as never,
    advisoryQuery: {} as never,
    letterRevision: {} as never,
    correction: {} as never,
    chartNote: {} as never,
    appUser: {} as never,
    appUserRole: {} as never,
    scCondition: {} as never,
    activeProblem: {} as never,
    activeMedication: {} as never,
    signOff: {} as never,
    clarification: {} as never,
    fileReadStatus: {} as never,
    keyDoc: {} as never,
    doctorPack: {} as never,
    documentPage: {} as never,
    caseMessage: {} as never,
    email: {} as never,
    monitoredMailbox: {} as never,
    deliveryToken: {} as never,
    payment: {} as never,
    intake: {} as never,
    draftDecision: {} as never,
    $transaction: (async (fn: (tx: never) => unknown) => fn({} as never)) as never,
  };
}

describe('resolveCurrentPhysician', () => {
  it('returns null when cognitoSub is undefined', async () => {
    const db = buildDb({});
    const result = await resolveCurrentPhysician(db, undefined);
    expect(result).toBeNull();
  });

  it('returns null when cognitoSub is empty string', async () => {
    const db = buildDb({});
    const result = await resolveCurrentPhysician(db, '');
    expect(result).toBeNull();
  });

  it('returns null when no physician matches the cognitoSub', async () => {
    const db = buildDb({});
    const result = await resolveCurrentPhysician(db, 'cog-unknown');
    expect(result).toBeNull();
  });

  it('returns the physician when a match exists', async () => {
    const physician = buildPhysician({ cognitoSub: 'cog-abc-123' });
    const db = buildDb({ 'cog-abc-123': physician });
    const result = await resolveCurrentPhysician(db, 'cog-abc-123');
    expect(result).toEqual(physician);
  });

  it('returns null when the matched physician is inactive', async () => {
    const physician = buildPhysician({ cognitoSub: 'cog-abc-123', active: false });
    const db = buildDb({ 'cog-abc-123': physician });
    const result = await resolveCurrentPhysician(db, 'cog-abc-123');
    expect(result).toBeNull();
  });
});

describe('isAssignedPhysicianForCase', () => {
  it('returns false when assignedPhysicianId is null', async () => {
    const db = buildDb({ 'cog-abc-123': buildPhysician() });
    const result = await isAssignedPhysicianForCase(db, 'cog-abc-123', null);
    expect(result).toBe(false);
  });

  it('returns false when cognito user has no physician mapping', async () => {
    const db = buildDb({});
    const result = await isAssignedPhysicianForCase(db, 'cog-unknown', 'phys-001');
    expect(result).toBe(false);
  });

  it('returns false when physician id does not match assigned id', async () => {
    const physician = buildPhysician({ id: 'phys-001', cognitoSub: 'cog-abc-123' });
    const db = buildDb({ 'cog-abc-123': physician });
    const result = await isAssignedPhysicianForCase(db, 'cog-abc-123', 'phys-other');
    expect(result).toBe(false);
  });

  it('returns true when physician id matches assigned id', async () => {
    const physician = buildPhysician({ id: 'phys-001', cognitoSub: 'cog-abc-123' });
    const db = buildDb({ 'cog-abc-123': physician });
    const result = await isAssignedPhysicianForCase(db, 'cog-abc-123', 'phys-001');
    expect(result).toBe(true);
  });

  it('returns false when physician matches id but is inactive', async () => {
    const physician = buildPhysician({ id: 'phys-001', cognitoSub: 'cog-abc-123', active: false });
    const db = buildDb({ 'cog-abc-123': physician });
    const result = await isAssignedPhysicianForCase(db, 'cog-abc-123', 'phys-001');
    expect(result).toBe(false);
  });
});
