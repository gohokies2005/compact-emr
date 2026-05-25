import { SignJWT } from 'jose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import type { AppDb, AppDbTransaction, AppUserRecord, VeteranRecord, ActiveProblemRecord, ActiveMedicationRecord } from '../services/db-types.js';

const secret = new TextEncoder().encode('phase3a-test-secret');

async function makeJwt(groups: string[], sub = 'test-sub-123') {
  return new SignJWT({ email: 'admin@example.test', 'cognito:groups': groups })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer('compact-emr-test')
    .setAudience('compact-emr-api')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(secret);
}

function sampleVeteran(overrides: Partial<VeteranRecord> = {}): VeteranRecord {
  const now = new Date('2026-05-24T00:00:00.000Z');
  return {
    id: 'TEST-001',
    lastName: 'Smith',
    firstName: 'John',
    dob: new Date('1980-01-01T00:00:00.000Z'),
    email: 'smith@example.test',
    phone: null,
    address: null,
    branch: 'Army',
    serviceStartYear: 2001,
    serviceEndYear: 2008,
    combatVeteran: 'unknown',
    pactArea: 'unknown',
    teraConceded: 'unknown',
    heightIn: null,
    weightLb: null,
    inactive: false,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

class MockDb {
  public veterans = new Map<string, VeteranRecord>();
  public activities: Array<{ data: Record<string, unknown> }> = [];
  public appUserRecord: AppUserRecord | null = {
    id: 'app-user-1',
    cognitoSub: 'test-sub-123',
    email: 'admin@example.test',
    roles: [{ role: 'admin' }],
  };

  public appUser = {
    findUnique: async (): Promise<AppUserRecord | null> => this.appUserRecord,
  };

  public activityLog = {
    create: async (args: { data: Record<string, unknown> }): Promise<unknown> => {
      this.activities.push(args);
      return args.data;
    },
  };

  public veteran = {
    findMany: async (): Promise<Array<VeteranRecord & { _count: { cases: number } }>> =>
      [...this.veterans.values()].filter((v) => !v.inactive).map((v) => ({ ...v, _count: { cases: 0 } })),
    count: async (): Promise<number> => [...this.veterans.values()].filter((v) => !v.inactive).length,
    findUnique: async (args: unknown): Promise<VeteranRecord | null> => {
      const id = this.extractId(args);
      return this.veterans.get(id) ?? null;
    },
    findFirst: async (args: unknown): Promise<VeteranRecord | null> => {
      const id = this.extractId(args);
      const veteran = this.veterans.get(id) ?? null;
      return veteran && !veteran.inactive ? veteran : null;
    },
    create: async (args: { data: Omit<VeteranRecord, 'createdAt' | 'updatedAt' | 'version' | 'inactive'> }): Promise<VeteranRecord> => {
      const created = sampleVeteran({ ...args.data, version: 1, inactive: false });
      this.veterans.set(created.id, created);
      return created;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }): Promise<VeteranRecord> => {
      const current = this.veterans.get(args.where.id);
      if (!current) throw new Error('missing veteran in mock');
      const nextVersion = typeof args.data.version === 'object' && args.data.version !== null ? current.version + 1 : current.version;
      const { version: _version, ...rest } = args.data;
      const updated = { ...current, ...rest, version: nextVersion, updatedAt: new Date('2026-05-24T01:00:00.000Z') } as VeteranRecord;
      this.veterans.set(args.where.id, updated);
      return updated;
    },
  };

  public problems = new Map<string, ActiveProblemRecord>();
  public medications = new Map<string, ActiveMedicationRecord>();
  private nextProblemSeq = 1;
  private nextMedicationSeq = 1;

  public activeProblem = {
    findUnique: async (args: unknown): Promise<ActiveProblemRecord | null> => {
      const id = this.extractId(args);
      return this.problems.get(id) ?? null;
    },
    findFirst: async (args: unknown): Promise<ActiveProblemRecord | null> => {
      if (typeof args !== 'object' || args === null) return null;
      const where = (args as { where?: Record<string, string> }).where ?? {};
      for (const row of this.problems.values()) {
        if (where.id !== undefined && row.id !== where.id) continue;
        if (where.veteranId !== undefined && row.veteranId !== where.veteranId) continue;
        return row;
      }
      return null;
    },
    findMany: async (): Promise<readonly ActiveProblemRecord[]> => [...this.problems.values()],
    create: async (args: { data: Omit<ActiveProblemRecord, 'id' | 'createdAt' | 'updatedAt' | 'version'> }): Promise<ActiveProblemRecord> => {
      const id = `PROB-${this.nextProblemSeq++}`;
      const now = new Date('2026-05-25T12:00:00.000Z');
      const row: ActiveProblemRecord = { id, ...args.data, createdAt: now, updatedAt: now, version: 1 };
      this.problems.set(id, row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<ActiveProblemRecord> }): Promise<ActiveProblemRecord> => {
      const current = this.problems.get(args.where.id);
      if (!current) throw new Error('missing problem in mock');
      const updated: ActiveProblemRecord = { ...current, ...args.data };
      this.problems.set(args.where.id, updated);
      return updated;
    },
    delete: async (args: { where: { id: string } }): Promise<ActiveProblemRecord> => {
      const current = this.problems.get(args.where.id);
      if (!current) throw new Error('missing problem in mock');
      this.problems.delete(args.where.id);
      return current;
    },
  };

  public activeMedication = {
    findUnique: async (args: unknown): Promise<ActiveMedicationRecord | null> => {
      const id = this.extractId(args);
      return this.medications.get(id) ?? null;
    },
    findFirst: async (args: unknown): Promise<ActiveMedicationRecord | null> => {
      if (typeof args !== 'object' || args === null) return null;
      const where = (args as { where?: Record<string, string> }).where ?? {};
      for (const row of this.medications.values()) {
        if (where.id !== undefined && row.id !== where.id) continue;
        if (where.veteranId !== undefined && row.veteranId !== where.veteranId) continue;
        return row;
      }
      return null;
    },
    findMany: async (): Promise<readonly ActiveMedicationRecord[]> => [...this.medications.values()],
    create: async (args: { data: Omit<ActiveMedicationRecord, 'id' | 'createdAt' | 'updatedAt' | 'version'> }): Promise<ActiveMedicationRecord> => {
      const id = `MED-${this.nextMedicationSeq++}`;
      const now = new Date('2026-05-25T12:00:00.000Z');
      const row: ActiveMedicationRecord = { id, ...args.data, createdAt: now, updatedAt: now, version: 1 };
      this.medications.set(id, row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<ActiveMedicationRecord> }): Promise<ActiveMedicationRecord> => {
      const current = this.medications.get(args.where.id);
      if (!current) throw new Error('missing medication in mock');
      const updated: ActiveMedicationRecord = { ...current, ...args.data };
      this.medications.set(args.where.id, updated);
      return updated;
    },
    delete: async (args: { where: { id: string } }): Promise<ActiveMedicationRecord> => {
      const current = this.medications.get(args.where.id);
      if (!current) throw new Error('missing medication in mock');
      this.medications.delete(args.where.id);
      return current;
    },
  };

  public async $transaction<T>(fn: (tx: AppDbTransaction) => Promise<T>): Promise<T> {
    return fn(this as unknown as AppDbTransaction);
  }

  private extractId(args: unknown): string {
    if (typeof args !== 'object' || args === null) return '';
    const maybeWhere = (args as { where?: unknown }).where;
    if (typeof maybeWhere !== 'object' || maybeWhere === null) return '';
    const id = (maybeWhere as { id?: unknown }).id;
    return typeof id === 'string' ? id : '';
  }
}

beforeEach(() => {
  process.env.AUTH_TEST_JWT_SECRET = 'phase3a-test-secret';
  process.env.AUTH_TEST_ISSUER = 'compact-emr-test';
  process.env.AUTH_TEST_AUDIENCE = 'compact-emr-api';
});

describe('Phase 3A-1 veteran routes', () => {
  it('GET /api/v1/me returns the authenticated user envelope', async () => {
    const db = new MockDb();
    const token = await makeJwt(['admin']);
    const res = await request(createApp({ db: db as unknown as AppDb })).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sub: 'test-sub-123', roles: ['admin'], appUserId: 'app-user-1' });
  });

  it('POST /api/v1/veterans creates a veteran and writes an activity row', async () => {
    const db = new MockDb();
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans')
      .set('Authorization', `Bearer ${token}`)
      .send({
        id: 'TEST-001',
        firstName: 'John',
        lastName: 'Smith',
        dob: '1980-01-01',
        email: 'smith@example.test',
        branch: 'Army',
        serviceStartYear: 2001,
        serviceEndYear: 2008,
        combatVeteran: 'unknown',
        pactArea: 'unknown',
        teraConceded: 'unknown',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('TEST-001');
    expect(db.activities[0]?.data).toMatchObject({ action: 'veteran_created', veteranId: 'TEST-001' });
  });

  it('GET /api/v1/veterans rejects missing JWT with 401', async () => {
    const db = new MockDb();
    const res = await request(createApp({ db: db as unknown as AppDb })).get('/api/v1/veterans');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('GET /api/v1/veterans rejects physician role with 403', async () => {
    const db = new MockDb();
    const token = await makeJwt(['physician']);
    const res = await request(createApp({ db: db as unknown as AppDb })).get('/api/v1/veterans').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('PATCH /api/v1/veterans/:id increments version and writes fields-only activity details', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/veterans/TEST-001')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, email: 'new@example.test' });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(db.activities[0]?.data).toMatchObject({
      action: 'veteran_updated',
      veteranId: 'TEST-001',
      detailsJson: { veteranId: 'TEST-001', fields: ['email'] },
    });
  });

  it('PATCH /api/v1/veterans/:id returns 409 on stale version', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran({ version: 3 }));
    const token = await makeJwt(['admin']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/veterans/TEST-001')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, email: 'new@example.test' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.details).toMatchObject({ id: 'TEST-001', version: 3 });
  });

  it('PATCH /api/v1/veterans/:id blocks ops staff from changing name or DOB', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/veterans/TEST-001')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, lastName: 'Jones' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('DELETE /api/v1/veterans/:id is admin-only and soft deletes', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['admin']);
    const res = await request(createApp({ db: db as unknown as AppDb })).delete('/api/v1/veterans/TEST-001').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(db.veterans.get('TEST-001')?.inactive).toBe(true);
    expect(db.activities[0]?.data).toMatchObject({ action: 'veteran_soft_deleted', veteranId: 'TEST-001' });
  });
});

describe('Phase 5 chart entry routes (problems + medications)', () => {
  it('POST /veterans/:id/problems creates a problem with icd10 + writes activity', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/TEST-001/problems')
      .set('Authorization', `Bearer ${token}`)
      .send({ problem: 'Essential hypertension', icd10: 'I10', notes: 'On amlodipine' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ problem: 'Essential hypertension', icd10: 'I10', notes: 'On amlodipine', veteranId: 'TEST-001' });
    expect(db.activities[0]?.data).toMatchObject({ action: 'active_problem_created', veteranId: 'TEST-001' });
  });

  it('POST /veterans/:id/problems accepts the problem without an icd10', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/TEST-001/problems')
      .set('Authorization', `Bearer ${token}`)
      .send({ problem: 'Sciatica left leg' });

    expect(res.status).toBe(201);
    expect(res.body.data.icd10).toBeNull();
  });

  it('POST /veterans/:id/problems rejects malformed icd10 with 400', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/TEST-001/problems')
      .set('Authorization', `Bearer ${token}`)
      .send({ problem: 'Anxiety', icd10: 'not-a-code' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('POST /veterans/:id/problems returns 404 when veteran is missing', async () => {
    const db = new MockDb();
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/NOPE/problems')
      .set('Authorization', `Bearer ${token}`)
      .send({ problem: 'PTSD', icd10: 'F43.10' });

    expect(res.status).toBe(404);
  });

  it('DELETE /veterans/:vid/problems/:pid removes the row and writes activity', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.activeProblem.create({ data: { veteranId: 'TEST-001', problem: 'GERD', icd10: 'K21.9', notes: null } });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .delete('/api/v1/veterans/TEST-001/problems/PROB-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(db.problems.size).toBe(0);
    expect(db.activities[0]?.data).toMatchObject({ action: 'active_problem_deleted', veteranId: 'TEST-001' });
  });

  it('POST /veterans/:id/medications creates a medication with dose', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/TEST-001/medications')
      .set('Authorization', `Bearer ${token}`)
      .send({ drugName: 'Amlodipine 5 mg', dose: '5 mg', frequency: 'PO daily', indication: 'HTN' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ drugName: 'Amlodipine 5 mg', dose: '5 mg', frequency: 'PO daily', indication: 'HTN' });
  });

  it('POST /veterans/:id/medications accepts the drug without a dose (with-and-without-doses contract)', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/TEST-001/medications')
      .set('Authorization', `Bearer ${token}`)
      .send({ drugName: 'Sertraline' });

    expect(res.status).toBe(201);
    expect(res.body.data.dose).toBeNull();
    expect(res.body.data.frequency).toBeNull();
    expect(res.body.data.indication).toBeNull();
  });

  it('DELETE /veterans/:vid/medications/:mid removes the row', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.activeMedication.create({ data: { veteranId: 'TEST-001', drugName: 'Tadalafil', dose: null, frequency: null, indication: null } });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .delete('/api/v1/veterans/TEST-001/medications/MED-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(db.medications.size).toBe(0);
  });

  it('chart-entry routes reject physician role with 403', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['physician']);
    const probRes = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/TEST-001/problems')
      .set('Authorization', `Bearer ${token}`)
      .send({ problem: 'PTSD' });
    expect(probRes.status).toBe(403);

    const medRes = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/TEST-001/medications')
      .set('Authorization', `Bearer ${token}`)
      .send({ drugName: 'Sertraline' });
    expect(medRes.status).toBe(403);
  });
});
