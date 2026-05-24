export class OptimisticLockError extends Error {
  constructor(message = 'Record was modified by another user.') {
    super(message);
    this.name = 'OptimisticLockError';
  }
}

export interface VersionedRecord {
  version: number;
  updatedAt?: Date;
  updated_at?: Date;
}

export function assertVersion(currentVersion: number, expectedVersion: number): void {
  if (currentVersion !== expectedVersion) {
    throw new OptimisticLockError(`Version conflict: expected ${expectedVersion}, found ${currentVersion}.`);
  }
}

export function incrementVersion<T extends VersionedRecord>(record: T, expectedVersion: number): T & { version: number } {
  assertVersion(record.version, expectedVersion);
  return { ...record, version: record.version + 1 };
}
