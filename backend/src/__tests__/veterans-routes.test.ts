import { SignJWT } from 'jose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import type { AppDb, AppDbTransaction, AppUserRecord, VeteranRecord, ActiveProblemRecord, ActiveMedicationRecord, ScConditionRecord } from '../services/db-types.js';

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
    name: 'Test Admin',
    active: true,
    roles: [{ role: 'admin' }],
    version: 1,
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

  public conditions = new Map<string, ScConditionRecord>();
  public problems = new Map<string, ActiveProblemRecord>();
  public medications = new Map<string, ActiveMedicationRecord>();
  private nextConditionSeq = 1;
  private nextProblemSeq = 1;
  private nextMedicationSeq = 1;

  public scCondition = {
    findUnique: async (args: unknown): Promise<ScConditionRecord | null> => {
      const id = this.extractId(args);
      return this.conditions.get(id) ?? null;
    },
    findFirst: async (args: unknown): Promise<ScConditionRecord | null> => {
      if (typeof args !== 'object' || args === null) return null;
      const where = (args as { where?: Record<string, string> }).where ?? {};
      for (const row of this.conditions.values()) {
        if (where.id !== undefined && row.id !== where.id) continue;
        if (where.veteranId !== undefined && row.veteranId !== where.veteranId) continue;
        return row;
      }
      return null;
    },
    findMany: async (): Promise<readonly ScConditionRecord[]> => [...this.conditions.values()],
    create: async (args: { data: Omit<ScConditionRecord, 'id' | 'createdAt' | 'updatedAt' | 'version'> }): Promise<ScConditionRecord> => {
      const id = `COND-${this.nextConditionSeq++}`;
      const now = new Date('2026-05-25T12:00:00.000Z');
      const row: ScConditionRecord = { id, ...args.data, createdAt: now, updatedAt: now, version: 1 };
      this.conditions.set(id, row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }): Promise<ScConditionRecord> => {
      const current = this.conditions.get(args.where.id);
      if (!current) throw new Error('missing condition in mock');
      const nextVersion = typeof args.data.version === 'object' && args.data.version !== null ? current.version + 1 : current.version;
      const { version: _version, ...rest } = args.data;
      const updated = { ...current, ...rest, version: nextVersion, updatedAt: new Date('2026-05-25T13:00:00.000Z') } as ScConditionRecord;
      this.conditions.set(args.where.id, updated);
      return updated;
    },
    delete: async (args: { where: { id: string } }): Promise<ScConditionRecord> => {
      const current = this.conditions.get(args.where.id);
      if (!current) throw new Error('missing condition in mock');
      this.conditions.delete(args.where.id);
      return current;
    },
  };

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
    update: async (args: { where: { id: string }; data: Record<string, unknown> }): Promise<ActiveProblemRecord> => {
      const current = this.problems.get(args.where.id);
      if (!current) throw new Error('missing problem in mock');
      const nextVersion = typeof args.data.version === 'object' && args.data.version !== null ? current.version + 1 : current.version;
      const { version: _version, ...rest } = args.data;
      const updated = { ...current, ...rest, version: nextVersion } as ActiveProblemRecord;
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
    update: async (args: { where: { id: string }; data: Record<string, unknown> }): Promise<ActiveMedicationRecord> => {
      const current = this.medications.get(args.where.id);
      if (!current) throw new Error('missing medication in mock');
      const nextVersion = typeof args.data.version === 'object' && args.data.version !== null ? current.version + 1 : current.version;
      const { version: _version, ...rest } = args.data;
      const updated = { ...current, ...rest, version: nextVersion } as ActiveMedicationRecord;
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

describe('Phase 5 flat-id chart-entry CRUD (conditions + problems + medications)', () => {
  it('POST /veterans/:id/conditions creates an SC condition + writes activity', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/TEST-001/conditions')
      .set('Authorization', `Bearer ${token}`)
      .send({ condition: 'PTSD', dcCode: '9411', ratingPct: 70, grantedDate: '2020-03-15' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ condition: 'PTSD', dcCode: '9411', ratingPct: 70, veteranId: 'TEST-001' });
    expect(db.activities[0]?.data).toMatchObject({ action: 'sc_condition_created', veteranId: 'TEST-001' });
  });

  it('POST /veterans/:id/conditions accepts a bare condition (no dcCode/ratingPct/grantedDate)', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/TEST-001/conditions')
      .set('Authorization', `Bearer ${token}`)
      .send({ condition: 'Tinnitus' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ condition: 'Tinnitus', dcCode: null, ratingPct: null, grantedDate: null });
  });

  it('POST /veterans/:id/conditions rejects ratingPct out of range with 400', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/TEST-001/conditions')
      .set('Authorization', `Bearer ${token}`)
      .send({ condition: 'PTSD', ratingPct: 150 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('POST /veterans/:id/conditions returns 404 when veteran is missing', async () => {
    const db = new MockDb();
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .post('/api/v1/veterans/NOPE/conditions')
      .set('Authorization', `Bearer ${token}`)
      .send({ condition: 'PTSD' });

    expect(res.status).toBe(404);
  });

  it('PATCH /conditions/:id updates fields, increments version, writes activity', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.scCondition.create({ data: { veteranId: 'TEST-001', condition: 'PTSD', dcCode: '9411', ratingPct: 50, status: 'service_connected', grantedDate: null } });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/conditions/COND-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, ratingPct: 70 });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.ratingPct).toBe(70);
    expect(db.activities[0]?.data).toMatchObject({
      action: 'sc_condition_updated',
      veteranId: 'TEST-001',
      detailsJson: { veteranId: 'TEST-001', conditionId: 'COND-1', fields: ['ratingPct'] },
    });
  });

  it('PATCH /conditions/:id returns 409 on stale version', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.scCondition.create({ data: { veteranId: 'TEST-001', condition: 'PTSD', dcCode: null, ratingPct: null, status: 'service_connected', grantedDate: null } });
    const stale = db.conditions.get('COND-1')!;
    db.conditions.set('COND-1', { ...stale, version: 3 });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/conditions/COND-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, condition: 'PTSD with depression' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.details).toMatchObject({ id: 'COND-1', version: 3 });
  });

  it('PATCH /conditions/:id returns 404 when condition is missing', async () => {
    const db = new MockDb();
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/conditions/NOPE')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, ratingPct: 30 });

    expect(res.status).toBe(404);
  });

  it('DELETE /conditions/:id removes the row, resolves veteranId for activity', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.scCondition.create({ data: { veteranId: 'TEST-001', condition: 'PTSD', dcCode: null, ratingPct: null, status: 'service_connected', grantedDate: null } });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .delete('/api/v1/conditions/COND-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(db.conditions.size).toBe(0);
    expect(db.activities[0]?.data).toMatchObject({ action: 'sc_condition_deleted', veteranId: 'TEST-001', detailsJson: { conditionId: 'COND-1' } });
  });

  it('POST /veterans/:id/conditions defaults status to service_connected and accepts an explicit status', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    const token = await makeJwt(['ops_staff']);
    const app = createApp({ db: db as unknown as AppDb });

    const def = await request(app).post('/api/v1/veterans/TEST-001/conditions').set('Authorization', `Bearer ${token}`).send({ condition: 'PTSD' });
    expect(def.status).toBe(201);
    expect(def.body.data.status).toBe('service_connected');

    const pending = await request(app).post('/api/v1/veterans/TEST-001/conditions').set('Authorization', `Bearer ${token}`).send({ condition: 'Sleep apnea', status: 'pending' });
    expect(pending.status).toBe(201);
    expect(pending.body.data.status).toBe('pending');
  });

  it('PATCH /conditions/:id flips claim status (service_connected -> denied) and logs the field', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.scCondition.create({ data: { veteranId: 'TEST-001', condition: 'PTSD', dcCode: null, ratingPct: null, status: 'service_connected', grantedDate: null } });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/conditions/COND-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, status: 'denied' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('denied');
    expect(res.body.data.version).toBe(2);
    expect(db.activities[0]?.data).toMatchObject({ action: 'sc_condition_updated', detailsJson: { fields: ['status'] } });
  });

  it('PATCH /conditions/:id rejects an invalid claim status with 400', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.scCondition.create({ data: { veteranId: 'TEST-001', condition: 'PTSD', dcCode: null, ratingPct: null, status: 'service_connected', grantedDate: null } });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/conditions/COND-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, status: 'granted' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('PATCH /problems/:id (flat) updates and increments version', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.activeProblem.create({ data: { veteranId: 'TEST-001', problem: 'GERD', icd10: 'K21.9', notes: null } });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/problems/PROB-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, notes: 'On omeprazole' });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.notes).toBe('On omeprazole');
    expect(db.activities[0]?.data).toMatchObject({ action: 'active_problem_updated', veteranId: 'TEST-001' });
  });

  it('DELETE /problems/:id (flat) removes the row and resolves veteranId', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.activeProblem.create({ data: { veteranId: 'TEST-001', problem: 'GERD', icd10: 'K21.9', notes: null } });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .delete('/api/v1/problems/PROB-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(db.problems.size).toBe(0);
    expect(db.activities[0]?.data).toMatchObject({ action: 'active_problem_deleted', veteranId: 'TEST-001', detailsJson: { problemId: 'PROB-1' } });
  });

  it('PATCH /medications/:id (flat) updates and increments version', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.activeMedication.create({ data: { veteranId: 'TEST-001', drugName: 'Amlodipine', dose: '5 mg', frequency: null, indication: null } });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/medications/MED-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, dose: '10 mg' });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.dose).toBe('10 mg');
    expect(db.activities[0]?.data).toMatchObject({ action: 'active_medication_updated', veteranId: 'TEST-001' });
  });

  it('DELETE /medications/:id (flat) removes the row', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.activeMedication.create({ data: { veteranId: 'TEST-001', drugName: 'Tadalafil', dose: null, frequency: null, indication: null } });
    const token = await makeJwt(['ops_staff']);
    const res = await request(createApp({ db: db as unknown as AppDb }))
      .delete('/api/v1/medications/MED-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(db.medications.size).toBe(0);
    expect(db.activities[0]?.data).toMatchObject({ action: 'active_medication_deleted', veteranId: 'TEST-001' });
  });

  it('flat-id PATCH/DELETE reject physician role with 403', async () => {
    const db = new MockDb();
    db.veterans.set('TEST-001', sampleVeteran());
    await db.scCondition.create({ data: { veteranId: 'TEST-001', condition: 'PTSD', dcCode: null, ratingPct: null, status: 'service_connected', grantedDate: null } });
    const token = await makeJwt(['physician']);
    const patchRes = await request(createApp({ db: db as unknown as AppDb }))
      .patch('/api/v1/conditions/COND-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, ratingPct: 30 });
    expect(patchRes.status).toBe(403);

    const delRes = await request(createApp({ db: db as unknown as AppDb }))
      .delete('/api/v1/conditions/COND-1')
      .set('Authorization', `Bearer ${token}`);
    expect(delRes.status).toBe(403);
  });
});
